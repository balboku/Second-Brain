import json
import os
import glob

def merge_glossaries():
    glossary_files = glob.glob('system/glossary*.json')
    if not glossary_files:
        print("No glossary files found.")
        return

    merged_mappings = {}
    merged_conventions = {}

    # Sort files by name (which includes timestamp) so that later ones overwrite earlier ones
    glossary_files.sort()

    for file_path in glossary_files:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if 'mappings' in data:
                    merged_mappings.update(data['mappings'])
                if 'conventions' in data:
                    merged_conventions.update(data['conventions'])
        except Exception as e:
            print(f"Error reading {file_path}: {e}")

    final_glossary = {
        "mappings": merged_mappings,
        "conventions": merged_conventions
    }

    target_path = 'system/glossary.json'
    
    # Write the merged result to the main glossary file
    with open(target_path, 'w', encoding='utf-8') as f:
        json.dump(final_glossary, f, indent=2, ensure_ascii=False)
    
    print(f"Merged {len(glossary_files)} files into {target_path}")

    # Delete the timestamped files
    for file_path in glossary_files:
        if ' ' in file_path: # Timestamped files have a space: 'glossary 2026...'
            os.remove(file_path)
            print(f"Deleted {file_path}")

if __name__ == "__main__":
    merge_glossaries()
