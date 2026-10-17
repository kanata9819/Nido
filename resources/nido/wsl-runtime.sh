#!/bin/sh
set -eu

# Install only missing editor runtimes, without root or changes to the user's shell.
cache="${XDG_CACHE_HOME:-$HOME/.cache}/nido/runtime"
case "$(uname -m)" in
    x86_64)
        nvim_arch=x86_64
        node_arch=x64
        nvim_sha=b2f91117be5b5ea39edd7297156dc2a4a8df4add6c95a90809a8df19e7ab6f52
        node_sha=28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c
        ;;
    aarch64|arm64)
        nvim_arch=arm64
        node_arch=arm64
        nvim_sha=ea4f9a31b11cc1477ff014aebb7b207684e7280f94ffa97abdab6cacd9b98519
        node_sha=b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d
        ;;
    *) echo 'Nido supports WSL on x64 and ARM64 Linux.' >&2; exit 1 ;;
esac

nvim_bin="$(command -v nvim || true)"
# Nido's external highlight-state UI is validated against 0.11.x. System 0.12
# can crash during UI attachment; use the private pinned runtime in that case.
if [ -n "$nvim_bin" ] && ! "$nvim_bin" --clean --headless -u NONE -i NONE \
    -c "lua if vim.fn.has('nvim-0.11.5') == 0 or vim.fn.has('nvim-0.12') == 1 then vim.cmd('cquit') end" -c qa >/dev/null 2>&1; then
    nvim_bin=
fi
node_bin="$(command -v node || true)"
if [ -n "$node_bin" ] && ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    node_bin=
fi
if [ -z "$nvim_bin" ]; then nvim_bin="$cache/nvim-0.11.5/bin/nvim"; fi
if [ -z "$node_bin" ]; then node_bin="$cache/node-24.22.0/bin/node"; fi

if [ ! -x "$nvim_bin" ] || [ ! -x "$node_bin" ]; then
    for tool in curl tar sha256sum mktemp; do
        command -v "$tool" >/dev/null || { echo "WSL setup requires $tool." >&2; exit 1; }
    done
    mkdir -p -- "$cache"
    stage="$(mktemp -d "$cache/.setup-XXXXXXXX")"
    trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
    if [ ! -x "$nvim_bin" ]; then
        curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 \
            "https://github.com/neovim/neovim/releases/download/v0.11.5/nvim-linux-$nvim_arch.tar.gz" \
            -o "$stage/nvim.tar.gz"
        printf '%s  %s\n' "$nvim_sha" "$stage/nvim.tar.gz" | sha256sum -c - >&2
        tar -xzf "$stage/nvim.tar.gz" -C "$stage"
        "$stage/nvim-linux-$nvim_arch/bin/nvim" --version >/dev/null
        mv -T -- "$stage/nvim-linux-$nvim_arch" "$cache/nvim-0.11.5" || test -x "$nvim_bin"
    fi
    if [ ! -x "$node_bin" ]; then
        curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 \
            "https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-$node_arch.tar.gz" \
            -o "$stage/node.tar.gz"
        printf '%s  %s\n' "$node_sha" "$stage/node.tar.gz" | sha256sum -c - >&2
        tar -xzf "$stage/node.tar.gz" -C "$stage"
        "$stage/node-v24.22.0-linux-$node_arch/bin/node" --version >/dev/null
        mv -T -- "$stage/node-v24.22.0-linux-$node_arch" "$cache/node-24.22.0" || test -x "$node_bin"
    fi
fi
"$nvim_bin" --version >/dev/null
"$node_bin" --version >/dev/null
printf 'NIDO_NVIM=%s\nNIDO_NODE=%s\n' "$nvim_bin" "$node_bin"
