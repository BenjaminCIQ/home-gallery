"""
Generate systemd path units for each local source in provided config
"""

import yaml
from pathlib import Path

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("-c", "--config", required=True)
    parser.add_argument("-o", "--output-dir", required=True)
    args = parser.parse_args()
    with open(args.config) as f:
        config = yaml.safe_load(f)

    for source in config['sources']:
        if source['type'] != 'local':
            continue  # only create path units for local sources

        name = source['name']
        folder = source['path']

        path_unit = Path(args.output_dir) / f"photoframe-sync@{name}.path"

        content = f"[Unit]\nDescription=Watch local source '{name}' for Photoframe Sync\n\n[Path]\nPathModified={folder}\n\n[Install]\nWantedBy=multi-user.target"

        path_unit.write_text(content)
        print(f"Generated {path_unit}")

if __name__ == "__main__":
    main()
