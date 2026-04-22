#!/bin/bash
# meshterm installer
# Usage: curl -fsSL https://raw.githubusercontent.com/KenEzekiel/meshterm/main/install.sh | bash

set -e

echo "🕸️  meshterm installer"
echo ""

# Check for bun
if ! command -v bun &> /dev/null; then
  echo "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Clone or update
INSTALL_DIR="$HOME/.meshterm/src"
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating meshterm..."
  cd "$INSTALL_DIR" && git pull --quiet
else
  echo "Installing meshterm..."
  mkdir -p "$HOME/.meshterm"
  git clone https://github.com/KenEzekiel/meshterm.git "$INSTALL_DIR"
fi

# Link CLI
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/packages/cli/index.ts" "$HOME/.local/bin/meshterm"
chmod +x "$HOME/.local/bin/meshterm"

# Ensure PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc" 2>/dev/null || true
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc" 2>/dev/null || true
  export PATH="$HOME/.local/bin:$PATH"
fi

echo ""
echo "✅ meshterm installed!"
echo ""
echo "Next steps:"
echo "  meshterm init --server <url> --key <api-key> --agent <name>"
echo ""
echo "Or start a server:"
echo "  meshterm server start"
