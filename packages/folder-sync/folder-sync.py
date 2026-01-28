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
import subprocess
import requests
import urllib.parse
from typing import Dict, List, Tuple, Optional
from tqdm import tqdm
from xml.etree import ElementTree as ET


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


def check_sync_quarantine(config: dict, source: dict, ap: Path) -> Tuple[bool, bool]:
    """Determine if file should be ignored, quarantined or synced"""
    filter_media = source.get("filter_media", False)
    quarantine_enabled = source.get("quarantine", False)
    should_sync = is_media(ap, config) or not filter_media
    
    return should_sync, quarantine_enabled

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


def get_files_with_tag_local(config: dict, folder_path: str) -> List[str]:
    """
    Given a list of paths that are tagged (files or folders),
    return a flat list of file paths filtered by media_ext.
    If a path is a folder, recursively include all matching files.
    """

    media_exts = [ext.lower() for ext in config['media_ext']['images'] + config['media_ext']['videos']]
    result_files = []

    if Path(folder_path).is_dir():
        # Recursively glob files in folder
        for file_path in Path(folder_path).rglob("*"):
            if file_path.is_file() and file_path.suffix[1:].lower() in media_exts:
                result_files.append(str(file_path))
        # skip paths that do not exist

    return result_files


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
            nextcloud_file_id INTEGER,
            relative_path TEXT,
            mtime INTEGER,
            size INTEGER,
            exists_in_source INTEGER,
            exists_in_dest INTEGER,
            last_check INTEGER,
            quarantined INTEGER,
            active INTEGER
        );
    """)
    conn.commit()

def upsert_file_record(cur: sqlite3.Cursor, db_row: Optional[Tuple[int, int, int]],
                       source_name: str, source_type: str, file_id: int,
                       ap: Path, rp: Path,
                       mtime: int, size: int,
                       quarantined: bool
                       ) -> None:
    now: int = int(time.time())

    if db_row is None:
        cur.execute("""
            INSERT INTO files
            (source_name, source_type, source_path, nextcloud_file_id, relative_path,
             mtime, size, exists_in_source, exists_in_dest, last_check, quarantined, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (source_name, source_type, str(ap), file_id, str(rp), mtime, size, 1, 0, now, int(quarantined), 1))
    else:
        cur.execute("""
            UPDATE files
            SET mtime=?, size=?, exists_in_source=1, last_check=?, quarantined=?, active=?
            WHERE source_path=?
        """, (mtime, size, now, int(quarantined), 1, str(ap)))


# ===============================================================
# Nextcloud API
# ===============================================================
def nc_tag_id(config: dict, tag_name: str) -> Optional[str]:
    """
    Return Nextcloud tag ID using WebDAV.
    Scans /systemtags-assigned/image to find the tag with the given display-name.
    """

    base = config["nextcloud"]["server_ip"].rstrip("/")  # e.g. http://ip_addr
    auth = (config["nextcloud"]["username"], config["nextcloud"]["app_password"])

    url = f"{base}/nextcloud/remote.php/dav/systemtags-assigned"

    # XML body specifying the properties we want
    xml_body = '''<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <oc:id/>            
    <oc:display-name/> 
    <oc:user-visible/>
    <oc:user-assignable/>
    <oc:can-assign/>
    <nc:reference-fileid/>                 
  </d:prop>         
</d:propfind>'''

    headers = {"Content-Type": "text/xml", "Depth": "1"}  # Depth:1 to list immediate children

    # Send PROPFIND with XML body
    r = requests.request("PROPFIND", url, auth=auth, headers=headers, data=xml_body)
    r.raise_for_status()

    # Parse XML response
    root = ET.fromstring(r.content)

    ns = {
        "d": "DAV:",
        "oc": "http://owncloud.org/ns",
        "nc": "http://nextcloud.org/ns"
    }

    # Iterate over all <d:response> elements
    for response in root.findall("d:response", ns):
        display_name_el = response.find(".//oc:display-name", ns)
        id_el = response.find(".//oc:id", ns)
        if display_name_el is not None and id_el is not None:
            if display_name_el.text == tag_name:
                return id_el.text.strip()

    return None



def get_files_with_tag(config: dict, tag_id: int) -> List[Tuple[str, int]]:
    """
    Return a list of file paths for all files assigned the given tag_id.
    If a path is a folder, recursively glob files according to media_ext config.
    """

    base = config["nextcloud"]["server_ip"].rstrip("/")  # e.g. http://ip_addr
    auth = (config["nextcloud"]["username"], config["nextcloud"]["app_password"])
    user_root = f"{base}/nextcloud/remote.php/dav/files/{config['nextcloud']['username']}/"

    # WebDAV REPORT body for filtering files by systemtag
    xml_body = f'''<?xml version="1.0"?>
<oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ocs="http://open-collaboration-services.org/ns">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontenttype/>
    <d:displayname/>
    <d:getetag/>
    <oc:fileid/>
  </d:prop>
  <oc:filter-rules>
    <oc:systemtag>{tag_id}</oc:systemtag>
  </oc:filter-rules>
</oc:filter-files>'''

    headers = {"Content-Type": "application/xml", "Depth": "infinity"}
    r = requests.request("REPORT", user_root, auth=auth, headers=headers, data=xml_body)
    r.raise_for_status()

    # Parse XML response
    root = ET.fromstring(r.content)

    ns = {
    "d": "DAV:",
    "oc": "http://owncloud.org/ns",
    "nc": "http://nextcloud.org/ns"
    }

    # Collect all paths (files and folders)
    paths: List[Tuple[str, int]] = []
    for resp in root.findall("d:response", ns):
        href_el = resp.find("d:href", ns)
        prop_el = resp.find("d:propstat/d:prop", ns)

        if href_el is None or prop_el is None:
            continue

        file_id = resp.find("d:propstat/d:prop/oc:fileid", ns)
        if file_id is None:
           print(f"[GET FILES][WARN] Unable to obtain tag for file {href_el.text}. Cannot remove label in case of deletion from frame...")

        href = href_el.text
        file_path = urllib.parse.unquote(href.partition(f"/nextcloud/remote.php/dav/files/{config['nextcloud']['username']}/")[-1])
        paths.append((file_path, file_id.text if file_id is not None else -1))

    return paths


def gather_nc_tagged(config: dict, tag_name: str) -> List[Tuple[str, int]]:
    """Return list of absolute file paths for a Nextcloud tag."""
    tagid = nc_tag_id(config, tag_name)
    if not tagid:
        print(f"[WARN] Tag '{tag_name}' not found in Nextcloud")
        return []

    return get_files_with_tag(config, tagid)


# ===============================================================
# Entry Gathering
# ===============================================================

def gather_entries(config: dict, source: dict) -> List[Tuple[int, Path, Path, int, int]]:
    """
    Returns list of (absolute_path, relative_path, mtime, size)
    """
    entries: List[Tuple[int, Path, Path, int, int]] = []

    if source["type"] == "local":
        base = Path(source["path"]).expanduser()

        for dirpath, _, filenames in os.walk(base):
            dp = Path(dirpath)
            for f in filenames:
                ap = dp / f
                rp = ap.relative_to(base)
                st = ap.stat()
                entries.append((-1, ap, rp, int(st.st_mtime), st.st_size))

    elif source["type"] == "nextcloud_tag":
        tag = source["tag"]
        local_root = Path(source["path"])
        paths = gather_nc_tagged(config, tag)

        for rp_str, file_id in paths:
            if source["named_folder"] not in rp_str:
                continue
            print(rp_str)
            rp = Path(rp_str).relative_to(source["named_folder"])
            ap = (local_root / rp).expanduser()
            if not ap.exists():
                print(f"{ap} does not exist")
                continue
            if ap.is_dir():
                files = get_files_with_tag_local(config, ap)
                for f in files:
                    afp = Path(f)
                    rfp = afp.relative_to(local_root)
                    st = afp.stat()
                    entries.append((-1, afp, rfp, int(st.st_mtime), st.st_size))
                continue
            st = ap.stat()
            entries.append((file_id, ap, rp, int(st.st_mtime), st.st_size))
    return entries


# ===============================================================
# Sync Logic
# ===============================================================

def sync_source(config: dict, conn: sqlite3.Connection, source: dict, dest_root: Path) -> None:
    sname = source["name"]
    stype = source["type"]

    cur = conn.cursor()
    print(f"Syncing source: {sname}")
    entries = gather_entries(config, source)
    for f in entries:
       print(f)
<<<<<<< HEAD

=======
>>>>>>> 218bb89 (small fixes)
    if len(entries) == 0:
        print(f"[Sync Source {sname}] No entries found at all, assuming server connection issues...")
        return

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
    count=0
    for file_id, ap, rp, mtime, size in pbar:

        quarantined = filetype_restricted(config, source, ap)
        target_root = quarantine_root if quarantined else dest_root

        # DB check
        cur.execute(
            "SELECT id, mtime, size, nextcloud_file_id, active FROM files WHERE source_path=?",
            (str(ap),)
        )
        row = cur.fetchone()

        changed = True
        active = 0
        if row:
            _id, old_m, old_s, file_id, active = row
            changed = not (old_m == mtime and old_s == size)

        dest = target_root / sname / rp

        # Only act on files that don't exist already or have changed
        if changed or not dest.exists():
            print(f"File {ap} is being synchronised! Changed: {changed} Exists: {dest.exists()}")

            # If row exists but no longer in dest, assume its been deleted via the PhotoFrame
            # In this case, we can either remove the tag or move the file from Uploaded to UploadRemoved
            if not dest.exists() and row:
                tag = source["tag"]
                print(f"File {ap} has been removed from dest, assuming deleted via photoframe!")
                if active == 0:
                    print("already marked as inactive")
                    continue
                # remove tag from file (if exists)
                file_id = row[3]
                if file_id == -1:
                    print(f"No file id found, tag will not be deleted...")
                    continue
                print(f"Removing nextcloud tag {tag} from ap which was deleted from PhotoFrame")
                cmd = ["sudo", "-u", "www-data", "php", "/var/www/html/nextcloud/occ", "tag:files:delete", str(file_id), tag, "public"]
                result = subprocess.run(cmd, capture_output=True, text=True)
                print(result.stdout)
                print(result.stderr)
                cur.execute(
                    "UPDATE files SET active = 0 WHERE source_path=?",
                    (str(ap),)
                )
                continue


            # skip unstable files
            if not is_stable(ap):
                print(f"[SKIP] unstable file: {ap}")
                continue

            # Update DB metadata
            upsert_file_record(cur, row, sname, stype, file_id, ap, rp, mtime, size, quarantined)

            # Apply symlink or quarantine action
            apply_file_action(ap, dest, quarantined)

            # Set that files exist in dest
            cur.execute(
                "UPDATE files SET exists_in_dest=1 WHERE source_path=?",
                (str(ap),)
            )
            count+=1

        cur.execute(
            "UPDATE files SET exists_in_source=1 WHERE source_path=?",
            (str(ap),)
        )

    print(f"Synced {count} files for PhotoFrame")

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
        WHERE exists_in_source = 0 AND exists_in_dest = 0 AND active = 1
        """)
    stale = cur.fetchall()
    print("Stale files:")
    for sname, rp, quarantined in stale:
        root = quarantine_root if quarantined else dest_root
        dest_path = root / sname / rp
        print(rp)
        if not quarantined:
            if dest_path.exists() or dest_path.is_symlink():
                print(f"[CLEANUP] removing stale dest: {dest_path}")
                dest_path.unlink(missing_ok=True)
            source = [x for x in config["sources"] if x["name"]==sname]
            if len(source) == 0:
                print(f"[CLEANUP][WARN] No source found with name {sname} in config")
                continue
            source = source[0]
            print(f"source for stale: {source['name']}")

            #if source["dest_on_frame_deletion"]:
            #    source_path = Path(config["dest_root"]) / Path(rp)
            #    dest_root = Path(source["dest_on_frame_deletion"])
            #    if source_path.exists() and dest_root.exists():
            #        # move source file to dest on frame
            #        target = dest_root / Path(rp)
            #        target.parent.mkdir(parents=True, exist_ok=True)
            #        source_path.rename(target)

        prune_empty_dirs(dest_path, root)

        cur.execute("""
            UPDATE files
            SET exists_in_dest = 0, mtime = ?, active = 0
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
