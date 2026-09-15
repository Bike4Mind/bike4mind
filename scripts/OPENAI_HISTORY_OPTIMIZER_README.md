# OpenAI History Optimizer for Bike4Mind

## 🎯 Purpose

This tool optimizes your OpenAI chat history export by removing audio and video files that aren't needed for import. This reduces the file size by **~95%** and prevents browser crashes during upload.

## 📋 What It Does

- ✅ Keeps all essential files: `conversations.json`, `chat.html`, etc.
- 🗑️ Removes audio/video folders (not used during import)
- 📦 Creates a new optimized zip file
- 💾 Reduces file size from ~1.1 GB to ~51 MB

## 🚀 How to Use

### Option 1: Command Line (Recommended)

1. Download your OpenAI export zip file
2. Open Terminal (Mac/Linux) or Command Prompt (Windows)
3. Navigate to the scripts directory:
   ```bash
   cd /path/to/lumina5/scripts
   ```
4. Run the optimizer:
   ```bash
   python3 optimize-openai-history.py /path/to/your-openai-export.zip
   ```

### Option 2: Drag and Drop (Mac/Linux)

1. Make the script executable (one time only):
   ```bash
   chmod +x optimize-openai-history.py
   ```
2. Drag your OpenAI export zip file onto the `optimize-openai-history.py` file

### Option 3: Interactive Mode

1. Run without arguments:
   ```bash
   python3 optimize-openai-history.py
   ```
2. Follow the prompts to enter your zip file path

## 📊 Example Output

```
============================================================
🚀 OpenAI History Optimizer for Bike4Mind
============================================================
📥 Input:  my-openai-export.zip
📤 Output: my-openai-export-optimized.zip

📊 Original size: 1.1 GB

🔍 Analyzing zip contents...
✅ Files to keep:   8 (268.8 MB)
🗑️  Files to remove: 1,659 (1.3 GB)

📦 Creating optimized zip file...

============================================================
✨ Optimization Complete!
============================================================
📦 Original size:  1.1 GB
📦 Optimized size: 51.2 MB
💾 Space saved:    1.0 GB (95.4%)

✅ Optimized file created: my-openai-export-optimized.zip

🎉 You can now upload this file to Bike4Mind without crashes!
============================================================
```

## 📦 What's Included in the Optimized File?

The optimized zip contains only the files needed for import:
- ✅ `conversations.json` (the main file used for import)
- ✅ `chat.html` (for viewing)
- ✅ `message_feedback.json`
- ✅ `shared_conversations.json`
- ✅ `user.json`
- ✅ Root-level images (if any)

## ❌ What's Removed?

- 🗑️ All `/audio` folders and contents
- 🗑️ All `/video` folders and contents
- 🗑️ Individual conversation folders (not used during import)
- 🗑️ File attachment folders (not used during import)

**Note:** These files are not used by the Bike4Mind import process. Only `conversations.json` is parsed and imported.

## 🔧 Requirements

- Python 3.6 or higher (usually pre-installed on Mac/Linux)
- No additional packages needed - uses only Python standard library

## 📍 Where is the Output File?

The optimized file is created in the same directory as your original file with `-optimized` added to the filename:
- Input: `my-openai-export.zip`
- Output: `my-openai-export-optimized.zip`

## 🆘 Troubleshooting

### "python3: command not found"
Try using `python` instead:
```bash
python optimize-openai-history.py your-file.zip
```

### "File not found"
Make sure to provide the full path to your zip file:
```bash
python3 optimize-openai-history.py ~/Downloads/my-export.zip
```

### Script doesn't run on Windows
On Windows, use:
```cmd
python optimize-openai-history.py your-file.zip
```

## 💡 Why Is This Needed?

OpenAI exports include all voice conversation recordings in audio folders. These can be **very large** (1+ GB) and cause browsers to crash when uploading. However, the Bike4Mind import process only reads the text data from `conversations.json`, so the audio files aren't needed.

This tool safely removes those unnecessary files while preserving everything needed for a successful import.

## 🔐 Privacy & Security

This script:
- ✅ Runs entirely on your local machine
- ✅ Does NOT upload data anywhere
- ✅ Does NOT modify your original zip file
- ✅ Only creates a new optimized copy

## 📝 Next Steps

After running the optimizer:
1. Upload the new `-optimized.zip` file to Bike4Mind
2. Go to your profile settings
3. Find "Import History" or "Upload LLM History"
4. Select the optimized file
5. Upload should complete successfully! 🎉
