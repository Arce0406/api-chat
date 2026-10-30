# 在 Linux 上編譯、測試桌面版的 Rust 部分（開發機不用安裝系統套件）。
# Windows／macOS 安裝檔由 GitHub Actions 建置（.github/workflows/release.yml）。
FROM rust:1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
      librsvg2-dev libssl-dev libayatana-appindicator3-dev pkg-config build-essential file \
    && rm -rf /var/lib/apt/lists/*
