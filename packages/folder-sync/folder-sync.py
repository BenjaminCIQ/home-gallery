"""
Final Folder Sync Script
-------------------------------------

Features:
- Local folder sources
- Nextcloud sources (system tags; supports tagged folders)
- Symlink-only destination
- State tracking via SQLite for fast incremental sync
- File stability check (size unchanged)
- Per-source sync via --source <name>
- Full sync when no source provided
- Dangling symlink and folder cleanup
"""

from __future__ import annotations

import os
import time
import yaml
import sqlite3
from pathlib import Path
import fcntl
import errno
import requests
from typing import Dict, List, Tuple, Optional
from tqdm import tqdm


# ===============================================================
# Helpers
# ===============================================================

def is_media(path: Path, config: dict) -> bool:
    ext = path.suffix.lower().lstrip('.')
    m = config["media_ext"]
    return ext in m["images"] or ext in m["videos"]


def is_stable(path: Path,
              mtime_threshold: float = 2.0,   # file modified in last N seconds?
              size_delay: float = 1.0) -> bool:
    """
    Fast + safe stability check:
    1. If mtime is older than threshold → file is stable.
    2. If mtime is recent → check size stability after a delay.
    """

    try:
        st1 = path.stat()
    except FileNotFoundError:
        return False

    now = time.time()
    age = now - st1.st_mtime

    # Case 1: File clearly stable (older mtime)
    if age > mtime_threshold:
        return True

    # Case 2: File very recent → deeper check
    time.sleep(size_delay)

    try:
        st2 = path.stat()
    except FileNotFoundError:
        return False

    return (st1.st_size == st2.st_size and
            st1.st_mtime == st2.st_mtime)


def filetype_restricted(config: dict, source: dict, ap: Path) -> bool:
    """Determine if file should be quarantined."""
    filter_media = source.get("filter_media", False)
    quarantine_enabled = source.get("quarantine", False)
    if filter_media and quarantine_enabled:
        return not is_media(ap, config)
    return False

def file_has_changed(db_row: Optional[Tuple[int, int, int]], mtime: int, size: int) -> bool:
    """Return True if no DB row exists or metadata mismatch."""
    if db_row is None:
        return True
    _id, old_m, old_s = db_row
    return not (old_m == mtime and old_s == size)


def apply_file_action(ap: Path, dest: Path, quarantined: bool) -> None:
    """Either move quarantined (non-media) file or create symlink in photo folder"""
    if not dest.parent.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        try:
            dest.unlink()
        except Exception:
            pass

    if quarantined:
        print(f"[QUARANTINE] Moving {ap} -> {dest}")
        try:
            ap.rename(dest)
        except Exception as e:
            print(f"[ERROR] Failed quarantine move: {e}")
    else:
        try:
            os.symlink(str(ap), str(dest))
        except FileExistsError:
            dest.unlink()
            os.symlink(str(ap), str(dest))


# ===============================================================
# SQLite State DB
# ===============================================================

def init_db(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY,
            source_name TEXT,
            source_type TEXT,
            source_path TEXT UNIQUE,
            relative_path TEXT,
            mtime INTEGER,
            size INTEGER,
            exists_in_source INTEGER,
            exists_in_dest INTEGER,
            last_check INTEGER,
            quarantined INTEGER
        );
    """)
    conn.commit()

def upsert_file_record(cur: sqlite3.Cursor, db_row: Optional[Tuple[int, int, int]],
                       source_name: str, source_type: str,
                       ap: Path, rp: Path,
                       mtime: int, size: int,
                       quarantined: bool
                       ) -> None:
    now: int = int(time.time())

    if db_row is None:
        cur.execute("""
            INSERT INTO files
            (source_name, source_type, source_path, relative_path,
             mtime, size, exists_in_source, exists_in_dest, last_check, quarantined)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (source_name, source_type, str(ap), str(rp), mtime, size, 1, 0, now, int(quarantined)))                                                                            
    else:
        cur.execute("""
            UPDATE files
            SET mtime=?, size=?, exists_in_source=1, last_check=?, quarantined=?
            WHERE source_path=?
        """, (mtime, size, now, int(quarantined), str(ap)))


# ===============================================================
# Nextcloud API
# ===============================================================

def nc_tag_id(config: dict, tag_name: str) -> Optional[str]:
    """Return Nextcloud tag ID."""
    base = config["nextcloud"]["webdav_base"]
    auth = (config["nextcloud"]["username"], config["nextcloud"]["app_password"])
    url = f"{base}/systemtags/"

    r = requests.request("PROPFIND", url, auth=auth)
    r.raise_for_status()

    for block in r.text.split("<d:response>"):
        if f"<oc:display-name>{tag_name}</oc:display-name>" in block:
            if "<oc:id>" in block:
                return block.split("<oc:id>")[1].split("</oc:id>")[0].strip()

    return None


def nc_tag_relations(config: dict, tag_id: str) -> List[str]:
    """Return list of node IDs associated with a tag."""
    base = config["nextcloud"]["webdav_base"]
    auth = (config["nextcloud"]["username"], config["nextcloud"]["app_password"])
    url = f"{base}/systemtags-relations/{tag_id}/"

    r = requests.request("PROPFIND", url, auth=auth)
    r.raise_for_status()

    ids: List[str] = []
    for block in r.text.split("<d:response>"):
        if "<oc:id>" in block:
            nid = block.split("<oc:id>")[1].split("</oc:id>")[0].strip()
            ids.append(nid)
    return ids


def nc_node_meta(config: dict, node_id: str) -> Tuple[Optional[Path], Optional[bool]]:
    """
    Returns (absolute local path, is_dir)
    """
    base = config["nextcloud"]["webdav_base"]
    auth = (config["nextcloud"]["username"], config["nextcloud"]["app_password"])
    local_root = Path(config["nextcloud"]["local_data_root"])

    meta_url = f"{base}/meta/{node_id}/v"
    r = requests.request("PROPFIND", meta_url, auth=auth)

    if r.status_code >= 400:
        return None, None

    xml = r.text

    if "<oc:meta-path>" not in xml:
        return None, None

    relative = xml.split("<oc:meta-path>")[1].split("</oc:meta-path>")[0].strip()
    is_dir = "<d:collection/>" in xml

    return local_root / relative, is_dir


def gather_nc_tagged(config: dict, tag_name: str) -> List[str]:
    """Return list of absolute file paths for a Nextcloud tag."""
    tagid = nc_tag_id(config, tag_name)
    if not tagid:
        print(f"[WARN] Tag '{tag_name}' not found in Nextcloud")
        return []

    node_ids = nc_tag_relations(config, tagid)
    results: List[str] = []

    for nid in node_ids:
        path, is_dir = nc_node_meta(config, nid)
        if not path or not path.exists():
            continue

        if is_dir:
            for root, _, files in os.walk(path):
                for f in files:
                    results.append(str(Path(root) / f))
        else:
            results.append(str(path))

    return results


# ===============================================================
# Entry Gathering
# ===============================================================

def gather_entries(config: dict, source: dict) -> List[Tuple[Path, Path, int, int]]:
    """
    Returns list of (absolute_path, relative_path, mtime, size)
    """
    entries: List[Tuple[Path, Path, int, int]] = []

    if source["type"] == "local":
        base = Path(source["path"]).expanduser()

        for dirpath, _, filenames in os.walk(base):
            dp = Path(dirpath)
            for f in filenames:
                ap = dp / f
                rp = ap.relative_to(base)
                st = ap.stat()
                entries.append((ap, rp, int(st.st_mtime), st.st_size))

    elif source["type"] == "nextcloud":
        tag = source["tag"]
        local_root = Path(config["nextcloud"]["local_data_root"]).expanduser()
        paths = gather_nc_tagged(config, tag)

        for ap_str in paths:
            ap = Path(ap_str)
            if not ap.exists():
                continue
            rp = ap.relative_to(local_root)
            st = ap.stat()
            entries.append((ap, rp, int(st.st_mtime), st.st_size))

    return entries


# ===============================================================
# Sync Logic
# ===============================================================

def sync_source(config: dict, conn: sqlite3.Connection, source: dict, dest_root: Path) -> None:
    sname = source["name"]
    stype = source["type"]

    cur = conn.cursor()
    entries = gather_entries(config, source)

    # Reset existence markers for this source
    cur.execute(
        "UPDATE files SET exists_in_source=0, exists_in_dest=0 WHERE source_name=?",
        (sname,),
    )

    quarantine_root = Path(config["quarantine_root"]).expanduser()

    pbar = tqdm(
        entries,
        desc=f"Syncing {sname}",
        unit="file",
        mininterval=0.5,   # update every 0.5s max
        disable=config["disable_progress"]
    )

    for ap, rp, mtime, size in pbar:
        quarantined = filetype_restricted(config, source, ap)
        target_root = quarantine_root if quarantined else dest_root

        # DB check
        cur.execute(
            "SELECT id, mtime, size FROM files WHERE source_path=?",
            (str(ap),)
        )
        row = cur.fetchone()

        changed = True
        if row:
            _id, old_m, old_s = row
            changed = not (old_m == mtime and old_s == size)
        
        dest = target_root / sname / rp

        # Only act on files that don't exist already or have changed
        if changed or not dest.exists():

            # skip unstable files
            if not is_stable(ap):
                print(f"[SKIP] unstable file: {ap}")
                continue

            # Update DB metadata
            upsert_file_record(cur, row, sname, stype, ap, rp, mtime, size, quarantined)

            # Apply symlink or quarantine action
            apply_file_action(ap, dest, quarantined)
            
            # Set that files exist in dest
            cur.execute(
                "UPDATE files SET exists_in_dest=1 WHERE source_path=?",
                (str(ap),)
            )

        cur.execute(
            "UPDATE files SET exists_in_source=1 WHERE source_path=?",
            (str(ap),)
        )

    # Check DB for expected files in
        cur.execute(
            "SELECT id, mtime, size FROM files WHERE source_path=?",
            (str(ap),)
        )
        row = cur.fetchone()

    conn.commit()


def prune_empty_dirs(leaf: Path, root: Path) -> None:
    """
    Clean empty folder levels between leaf and root
    """
    parent = leaf.parent

    # Walk upward but never remove or step above root
    while parent != root and parent.exists():
        try:
            # If directory is empty, remove it and go up
            if not any(parent.iterdir()):
                parent.rmdir()
            else:
                break # not empty means all folders above are not empty either
        except OSError:
            # Directory not removable (permissions, race conditions, etc.)
            break

        parent = parent.parent


# ===============================================================
# Cleanup
# ===============================================================

def cleanup(config: dict, conn: sqlite3.Connection, dest_root: Path) -> None:
    """
    Remove stale symlinks and any resulting empty folder branches.
    """
    cur = conn.cursor()
    now = int(time.time())

    quarantine_root = Path(config["quarantine_root"]).expanduser()

    cur.execute("""
        SELECT source_name, relative_path, quarantined
        FROM files
        WHERE exists_in_source = 0
        """)
    stale = cur.fetchall()

    for sname, rp, quarantined in stale:
        root = quarantine_root if quarantined else dest_root
        dest_path = root / sname / rp

        if not quarantined:
            if dest_path.exists() or dest_path.is_symlink():
                print(f"[CLEANUP] removing stale dest: {dest_path}")
                dest_path.unlink(missing_ok=True)

        prune_empty_dirs(dest_path, root)

        cur.execute("""
            UPDATE files
            SET exists_in_dest = 0, mtime = ?
            WHERE source_name = ? AND relative_path = ?
        """, (now, sname, rp))

    conn.commit()


# ===============================================================
# Main
# ===============================================================

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("-c", "--config", required=True)
    parser.add_argument("-s", "--source", help="sync only this source")
    args = parser.parse_args()

    with open(args.config) as f:
        config = yaml.safe_load(f)

    dest_root = Path(config["dest_root"]).expanduser()

    # Lock
    lockfile = Path(config.get("lockfile", "/tmp/folder-sync.lock"))
    lf = open(lockfile, "w")
    try:
        fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        if e.errno == errno.EAGAIN:
            print("Another sync already running.")
            return
        raise

    # Load sources
    if not args.source or args.source == 'timer':
        sources = config["sources"]
        print(f"folder-sync called for: {args.source}")
    else:
        matching = [s for s in config["sources"] if s["name"] == args.source]
        if not matching:
            print(f"[ERROR] No source named '{args.source}'")
            return
        sources = matching

    # DB
    db_path = Path(config.get("state_db", "folder-sync.db")).expanduser()

    conn = sqlite3.connect(str(db_path))
    init_db(conn)

    for src in sources:
        sync_source(config, conn, src, dest_root)

    cleanup(config, conn, dest_root)

    conn.close()


if __name__ == "__main__":
    main()
