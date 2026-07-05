#!/usr/bin/env python3
"""
OpenAI History Optimizer for Bike4Mind

This script removes audio and video files from your OpenAI chat history export
to significantly reduce file size and prevent browser crashes during upload.

The import process only needs conversations.json - multimedia files are not used.

Usage:
    python optimize-openai-history.py <path-to-zip-file>

    Or drag and drop the zip file onto this script (on most systems)

Example:
    python optimize-openai-history.py my-openai-export.zip
"""

import sys
import os
import zipfile
import tempfile
import shutil
from pathlib import Path


def format_size(bytes_size):
    """Convert bytes to human-readable format."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.1f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.1f} TB"


def should_include_file(file_path):
    """
    Determine if a file should be included in the optimized export.

    Include: JSON and HTML files at root level
    Exclude: Audio/video folders and their contents
    """
    parts = Path(file_path).parts

    # Exclude hidden/system files
    if any(part.startswith('.') for part in parts):
        return False

    # Exclude audio and video folders and their contents
    if 'audio' in parts or 'video' in parts:
        return False

    # Include essential files at root level
    if len(parts) == 1 and file_path.endswith(('.json', '.html', '.jpeg', '.jpg', '.png')):
        return True

    # Exclude everything else (conversation folders, file-* folders, etc.)
    return False


def optimize_openai_history(input_zip_path):
    """
    Create an optimized version of the OpenAI history export.

    Args:
        input_zip_path: Path to the original OpenAI export zip file

    Returns:
        Path to the optimized zip file
    """
    input_path = Path(input_zip_path)

    # Validate input
    if not input_path.exists():
        print(f"❌ Error: File not found: {input_zip_path}")
        return None

    if not input_path.suffix.lower() == '.zip':
        print(f"❌ Error: File must be a .zip file: {input_zip_path}")
        return None

    # Create output filename
    output_path = input_path.parent / f"{input_path.stem}-optimized.zip"

    print("\n" + "="*60)
    print("🚀 OpenAI History Optimizer for Bike4Mind")
    print("="*60)
    print(f"📥 Input:  {input_path.name}")
    print(f"📤 Output: {output_path.name}")
    print()

    # Get original file size
    original_size = input_path.stat().st_size
    print(f"📊 Original size: {format_size(original_size)}")
    print()

    try:
        print("🔍 Analyzing zip contents...")

        included_files = []
        excluded_files = []
        included_size = 0
        excluded_size = 0

        # First pass: analyze what we'll keep
        with zipfile.ZipFile(input_path, 'r') as zip_in:
            for info in zip_in.infolist():
                if info.is_dir():
                    continue

                if should_include_file(info.filename):
                    included_files.append(info)
                    included_size += info.file_size
                else:
                    excluded_files.append(info)
                    excluded_size += info.file_size

        print(f"✅ Files to keep:   {len(included_files):,} ({format_size(included_size)})")
        print(f"🗑️  Files to remove: {len(excluded_files):,} ({format_size(excluded_size)})")
        print()

        if len(included_files) == 0:
            print("❌ Error: No valid files found in the zip archive")
            return None

        # Check if conversations.json exists
        has_conversations = any('conversations.json' in f.filename for f in included_files)
        if not has_conversations:
            print("⚠️  Warning: conversations.json not found - this may not be a valid OpenAI export")
            response = input("Continue anyway? (y/n): ")
            if response.lower() != 'y':
                return None

        print("📦 Creating optimized zip file...")

        # Second pass: create optimized zip
        with zipfile.ZipFile(input_path, 'r') as zip_in:
            with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zip_out:
                for info in included_files:
                    # Read file data
                    data = zip_in.read(info.filename)
                    # Write to new zip
                    zip_out.writestr(info.filename, data)

        # Get final file size
        final_size = output_path.stat().st_size
        reduction = ((original_size - final_size) / original_size) * 100

        print()
        print("="*60)
        print("✨ Optimization Complete!")
        print("="*60)
        print(f"📦 Original size:  {format_size(original_size)}")
        print(f"📦 Optimized size: {format_size(final_size)}")
        print(f"💾 Space saved:    {format_size(original_size - final_size)} ({reduction:.1f}%)")
        print()
        print(f"✅ Optimized file created: {output_path.name}")
        print()
        print("🎉 You can now upload this file to Bike4Mind without crashes!")
        print("="*60)

        return output_path

    except zipfile.BadZipFile:
        print(f"❌ Error: Invalid or corrupted zip file: {input_zip_path}")
        return None
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        if output_path.exists():
            output_path.unlink()  # Clean up partial file
        return None


def main():
    """Main entry point."""
    print()

    # Check if file was provided
    if len(sys.argv) < 2:
        print("="*60)
        print("🚀 OpenAI History Optimizer for Bike4Mind")
        print("="*60)
        print()
        print("This tool removes audio/video files from your OpenAI export")
        print("to reduce file size and prevent browser crashes.")
        print()
        print("Usage:")
        print(f"    python {Path(__file__).name} <path-to-zip-file>")
        print()
        print("Or drag and drop your zip file onto this script.")
        print()
        print("Example:")
        print(f"    python {Path(__file__).name} my-openai-export.zip")
        print()
        print("="*60)

        # Interactive mode
        input_file = input("\nEnter path to your OpenAI export zip file: ").strip().strip('"\'')
        if not input_file:
            print("❌ No file provided. Exiting.")
            sys.exit(1)
    else:
        input_file = sys.argv[1].strip().strip('"\'')

    # Process the file
    result = optimize_openai_history(input_file)

    if result:
        # Only wait for input if running interactively
        if sys.stdin.isatty():
            print("\n✅ Success! Press Enter to exit...")
            input()
        sys.exit(0)
    else:
        if sys.stdin.isatty():
            print("\n❌ Failed! Press Enter to exit...")
            input()
        sys.exit(1)


if __name__ == "__main__":
    main()
