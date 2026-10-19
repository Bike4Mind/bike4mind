---
title: Troubleshooting
description: Common issues and solutions for B4M CLI
sidebar_position: 8
---

# Troubleshooting

Solutions to common issues and frequently asked questions.

## Installation Issues

### "command not found: b4m"

**Problem:** After installing, `b4m` command isn't recognized.

**Solutions:**

**1. Check if installed globally:**
```bash
npm list -g @bike4mind/cli
```

If not listed, install it:
```bash
npm install -g @bike4mind/cli
```

**2. Check your PATH:**
```bash
echo $PATH
```

Ensure npm's global bin directory is in your PATH:
```bash
# Find npm global bin directory
npm config get prefix

# Should output something like: /usr/local
# The bin directory is: /usr/local/bin
```

**3. Add to PATH (if missing):**
```bash
# For bash (~/.bashrc)
export PATH="$PATH:$(npm config get prefix)/bin"

# For zsh (~/.zshrc)
export PATH="$PATH:$(npm config get prefix)/bin"

# Reload shell
source ~/.bashrc  # or ~/.zshrc
```

**4. Use npx as workaround:**
```bash
npx @bike4mind/cli
```

---

### "permission denied" on macOS/Linux

**Problem:** Installation fails with EACCES permission error.

**Solution:** Use one of these methods:

**Method 1: Fix npm permissions (recommended)**
```bash
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g @bike4mind/cli
```

**Method 2: Use npx (no install)**
```bash
npx @bike4mind/cli
```

**Method 3: Use sudo (not recommended)**
```bash
sudo npm install -g @bike4mind/cli
```

**Why avoid sudo?**
- Can cause permission issues later
- Security risk
- Method 1 is better long-term solution

---

### Node.js version too old

**Problem:** Error about unsupported Node.js version.

**Check version:**
```bash
node --version
```

**Requirements:** Node.js 24 or higher

**Update Node.js:**

**Using nvm (recommended):**
```bash
# Install nvm if needed
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install latest Node.js
nvm install 24
nvm use 24
nvm alias default 24

# Verify
node --version  # Should show v24.x.x
```

**Using official installer:**
- Download from: https://nodejs.org/
- Install LTS version (24.x recommended)

---

## Authentication Issues

### Can't authenticate / login fails

**Problem:** OAuth flow doesn't complete or tokens don't save.

**Solutions:**

**1. Check internet connection:**
```bash
ping app.bike4mind.com
```

**2. Clear existing tokens:**
```bash
rm ~/.bike4mind/config.json
b4m
/login
```

**3. Check file permissions:**
```bash
ls -la ~/.bike4mind/config.json
# Should show: -rw------- (600)

# Fix if wrong:
chmod 600 ~/.bike4mind/config.json
```

**4. Try manual auth flow:**
```bash
b4m
/logout
/login
# Follow the verification URL manually
```

**5. Check for proxy/firewall:**
If behind corporate proxy:
```bash
export HTTP_PROXY=http://proxy.company.com:8080
export HTTPS_PROXY=http://proxy.company.com:8080
b4m
```

---

### "Unauthorized" or "Invalid token"

**Problem:** CLI shows authentication errors during use.

**Solutions:**

**1. Check token expiration:**
```bash
b4m
/whoami
# If shows expired, re-authenticate
/login
```

**2. Verify API endpoint:**
```bash
b4m
/api-info
# Should show: https://app.bike4mind.com/api

# If wrong, reset:
/reset-api
```

**3. Clear and re-authenticate:**
```bash
rm ~/.bike4mind/config.json
b4m
```

---

## Configuration Issues

### Config file corruption

**Problem:** CLI won't start due to invalid config.

**Solution:**

```bash
# Backup corrupt file
mv ~/.bike4mind/config.json ~/.bike4mind/config.broken.json

# Start CLI (creates new config)
b4m
/login
```

**Validate JSON:**
```bash
# Check if JSON is valid
cat ~/.bike4mind/config.json | python3 -m json.tool

# Or with jq
cat ~/.bike4mind/config.json | jq .
```

---

### Can't find config file

**Problem:** CLI can't read `~/.bike4mind/config.json`.

**Solutions:**

**1. Check if directory exists:**
```bash
ls ~/.bike4mind/
```

**2. Create if missing:**
```bash
mkdir -p ~/.bike4mind
chmod 700 ~/.bike4mind
```

**3. Fix permissions:**
```bash
chmod 700 ~/.bike4mind
chmod 600 ~/.bike4mind/config.json
```

---

## Tool Execution Issues

### Tool API key errors

**Problem:** "API key required" or "Invalid API key" errors.

**Solutions:**

**1. Add keys to config:**
```bash
# Edit config
nano ~/.bike4mind/config.json

# Add:
{
  "toolApiKeys": {
    "openweather": "your-key-here",
    "serper": "your-key-here"
  }
}
```

**2. Use environment variables:**
```bash
export OPENWEATHER_API_KEY="your-key"
export SERPER_API_KEY="your-key"
b4m
```

**3. Verify keys are valid:**
```bash
# Test OpenWeather key
curl "https://api.openweathermap.org/data/2.5/weather?q=London&appid=YOUR_KEY"

# Test Serper key
curl -X POST "https://google.serper.dev/search" \
  -H "X-API-KEY: YOUR_KEY" \
  -d '{"q":"test"}'
```

---

### "Permission denied" for bash_execute

**Problem:** Bash commands won't run or permission prompts appear.

**Solutions:**

**1. Grant permission when asked:**
```
Select: ✓ Always allow (trust this tool)
```

**2. Trust bash_execute upfront:**
```bash
b4m
/trust bash_execute
```

**3. Check tool isn't blocked:**
```bash
b4m
/trusted
# bash_execute should be in the list

# If blocked, untrust and re-trust:
/untrust bash_execute
/trust bash_execute
```

---

### MCP server won't start

**Problem:** MCP tools aren't available or server fails.

**Solutions:**

**1. Check server is enabled:**
```json
{
  "mcpServers": [
    {
      "name": "github",
      "enabled": true  // Must be true!
    }
  ]
}
```

**2. For Docker servers, check Docker:**
```bash
# Check if Docker is running
docker ps

# Start Docker if needed
# macOS: Open Docker Desktop
# Linux: sudo systemctl start docker
```

**3. For internal servers, build packages:**
```bash
cd /path/to/bike4mind
pnpm core:build
```

**4. Check environment variables:**
```json
{
  "env": {
    "GITHUB_ACCESS_TOKEN": "ghp_..."  // Must not be empty!
  }
}
```

**5. View debug logs:**
```bash
b4m --verbose
# Look for MCP server startup errors
```

---

## Performance Issues

### Slow responses

**Problem:** Agent takes a long time to respond.

**Causes & Solutions:**

**1. Network latency:**
```bash
# Test connection speed
curl -w "@-" -o /dev/null -s https://app.bike4mind.com/api << 'EOF'
     time_total: %{time_total}s
EOF
```

**2. Large context:**
- Avoid very large context files (keep under 10KB)
- Split large tasks into smaller steps

**3. Complex tool chains:**
- Agent making many tool calls sequentially
- This is normal for complex tasks

---

### High memory usage

**Problem:** CLI consuming excessive memory.

**Solutions:**

**1. Restart CLI regularly:**
```bash
# After long sessions
/exit
b4m
```

**2. Limit session size:**
```bash
# Save and start fresh after ~50 messages
/save my-work
/exit
b4m
```

**3. Check for memory leaks:**
```bash
# Monitor memory usage
top -pid $(pgrep -f bike4mind-cli)
```

---

## UI/Display Issues

### Colors don't display

**Problem:** Terminal shows escape codes instead of colors.

**Solutions:**

**1. Check terminal support:**
```bash
echo $TERM
# Should be: xterm-256color or similar
```

**2. Enable colors:**
```bash
export TERM=xterm-256color
b4m
```

**3. Disable colors if needed:**
```bash
export NO_COLOR=1
b4m
```

---

### Text wrapping issues

**Problem:** Long lines don't wrap correctly.

**Solution:**

**1. Resize terminal:**
- Make terminal wider
- Most readable at 80-120 columns

**2. Check terminal emulator:**
- Use modern terminal (iTerm2, Windows Terminal, GNOME Terminal)
- Avoid older terminals with limited rendering

---

### Unicode/emoji display issues

**Problem:** Emojis or special characters show as boxes.

**Solutions:**

**1. Use font with emoji support:**
- JetBrains Mono (recommended)
- Fira Code
- Cascadia Code

**2. Check locale:**
```bash
echo $LANG
# Should be: en_US.UTF-8 or similar

# Set if needed:
export LANG=en_US.UTF-8
```

---

## Debug & Logging Issues

### Can't find debug logs

**Problem:** Debug logs aren't being created.

**Solutions:**

**1. Check directory exists:**
```bash
ls ~/.bike4mind/debug/
```

**2. Create if missing:**
```bash
mkdir -p ~/.bike4mind/debug
chmod 755 ~/.bike4mind/debug
```

**3. Check disk space:**
```bash
df -h ~
# Ensure sufficient space available
```

---

### Verbose mode not working

**Problem:** `--verbose` flag doesn't show logs.

**Solutions:**

**1. Use correct flag:**
```bash
b4m --verbose    # ✓ Correct
b4m -v           # ✓ Also works
b4m verbose      # ✗ Wrong
```

**2. Check if logs appear in file:**
```bash
tail -f ~/.bike4mind/debug/*.txt
# Even without --verbose, logs go to file
```

---

## Connection Issues

### "Cannot connect to server"

**Problem:** CLI can't reach Bike4Mind API.

**Solutions:**

**1. Check internet:**
```bash
ping app.bike4mind.com
```

**2. Check firewall:**
- Ensure outbound HTTPS (port 443) is allowed
- Disable VPN temporarily to test

**3. Check API endpoint:**
```bash
b4m
/api-info
# Should show: https://app.bike4mind.com/api

# Reset if wrong:
/reset-api
```

**4. Try custom DNS:**
```bash
# Use Google DNS
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
```

---

### SSL/TLS errors

**Problem:** Certificate validation errors.

**Solutions:**

**1. Update Node.js:**
```bash
node --version
# Update to latest LTS if old
```

**2. Check system time:**
```bash
date
# Ensure system clock is correct
```

**3. Update certificates (macOS):**
```bash
brew install ca-certificates
```

**4. Update certificates (Linux):**
```bash
sudo apt update
sudo apt install ca-certificates
```

---

## Session Issues

### Session won't save

**Problem:** `/save` command fails or session not persisted.

**Solutions:**

**1. Check directory permissions:**
```bash
ls -ld ~/.bike4mind/sessions/
# Should be writable

# Fix if needed:
mkdir -p ~/.bike4mind/sessions
chmod 755 ~/.bike4mind/sessions
```

**2. Check disk space:**
```bash
df -h ~
```

**3. Try with different name:**
```bash
/save test-session
```

---

### Can't list sessions

**Problem:** `/sessions` shows no sessions but files exist.

**Solutions:**

**1. Check files exist:**
```bash
ls -la ~/.bike4mind/sessions/
```

**2. Validate JSON:**
```bash
# Check if session files are valid JSON
cat ~/.bike4mind/sessions/*.json | python3 -m json.tool
```

**3. Remove corrupt sessions:**
```bash
# Backup first
cp -r ~/.bike4mind/sessions ~/.bike4mind/sessions.backup

# Remove corrupt files (if identified)
rm ~/.bike4mind/sessions/corrupt-file.json
```

---

## Common Error Messages

### "ENOENT: no such file or directory"

**Cause:** Missing file or directory.

**Solution:**
```bash
# Recreate B4M directory structure
mkdir -p ~/.bike4mind/{sessions,debug}
chmod 700 ~/.bike4mind
```

---

### "EACCES: permission denied"

**Cause:** Insufficient file permissions.

**Solution:**
```bash
# Fix permissions
chmod 600 ~/.bike4mind/config.json
chmod 755 ~/.bike4mind/
chmod 755 ~/.bike4mind/sessions/
chmod 755 ~/.bike4mind/debug/
```

---

### "ERR_MODULE_NOT_FOUND"

**Cause:** Missing dependencies or build issue.

**Solution:**
```bash
# Reinstall CLI
npm uninstall -g @bike4mind/cli
npm install -g @bike4mind/cli

# Or clear npm cache
npm cache clean --force
npm install -g @bike4mind/cli
```

---

### "fetch failed" or "ECONNREFUSED"

**Cause:** Network or API endpoint issue.

**Solution:**
```bash
# 1. Check internet
ping app.bike4mind.com

# 2. Verify API endpoint
b4m
/api-info

# 3. Try reset
/reset-api
/logout
/login
```

---

## Getting More Help

### Enable Debug Logging

Always start here when troubleshooting:

```bash
b4m --verbose
```

View debug logs:
```bash
ls -ltr ~/.bike4mind/debug/ | tail -1  # Find latest log
tail -100 ~/.bike4mind/debug/[latest-file].txt
```

---

### Collect Diagnostic Info

When reporting issues, include:

```bash
# 1. Version
b4m --version

# 2. Node version
node --version

# 3. OS info
uname -a  # Linux/macOS
# or
ver  # Windows

# 4. Config (remove sensitive data!)
cat ~/.bike4mind/config.json | sed 's/"access.*"/"REDACTED"/g'

# 5. Recent debug log (last 50 lines, remove sensitive data!)
tail -50 ~/.bike4mind/debug/*.txt
```

---

### Report Issues

**GitHub Issues:** https://github.com/bike4mind/bike4mind/issues

**Include:**
1. Clear description of problem
2. Steps to reproduce
3. Expected vs actual behavior
4. Diagnostic info (see above)
5. Debug logs (sanitized)

---

## FAQ

### Q: Can I use B4M CLI offline?

**A:** No, B4M CLI requires internet connection for:
- Authentication
- API requests to Bike4Mind
- External tool APIs (weather, search, etc.)

Local models are supported via [Ollama](/cli/local-models) - point the CLI at your Ollama host to run models offline. Cloud features still require a connection.

---

### Q: How much does B4M CLI cost?

**A:** B4M CLI itself is free. You need:
- Bike4Mind account (check [pricing](https://bike4mind.com/pricing))
- Optional: Third-party API keys (OpenWeather, Serper) for specific tools

---

### Q: Can I use my own LLM?

**A:** Yes - see [Local Models](/cli/local-models) for running your own models via Ollama. You can also self-host the whole platform; see [Self-Hosting](/self-host).

---

### Q: Is my data secure?

**A:** Yes:
- Tokens stored with 600 permissions (owner-only)
- HTTPS for all API communication
- No data stored on device except sessions you explicitly save
- Self-hosted option available for enterprises

---

### Q: How do I uninstall?

```bash
# Remove CLI
npm uninstall -g @bike4mind/cli

# Remove data (optional)
rm -rf ~/.bike4mind
```

---

### Q: Can I contribute?

**A:** Yes! See [Contributing Guide](https://github.com/bike4mind/bike4mind/blob/main/CONTRIBUTING.md)

---

## See Also

- [Getting Started →](/cli/getting-started) - Setup guide
- [Configuration →](/cli/configuration) - Config options
- [Commands Reference →](/cli/commands) - All commands
- [GitHub Issues](https://github.com/bike4mind/bike4mind/issues) - Report problems
