# 07 — Packaging & Deployment

"Windows desktop app" isn't finished when it runs on your machine in dev mode — it's finished when it installs cleanly on a PC that has never seen Node.js or npm. This is the part most tutorials skip, and it's where `better-sqlite3` specifically will bite you if you don't set it up right.

## The native-module trap (read this before your first build, not after it breaks)

`better-sqlite3` is a **native module** — it ships a compiled `.node` binary, not pure JavaScript. This causes two very well-documented, very common problems, both with known fixes:

**Problem 1 — it was compiled for the wrong Node.** Electron bundles its own copy of Node.js, which is usually a different version/ABI than whatever Node you have installed on your dev machine. If `better-sqlite3` gets compiled against your system Node instead of Electron's bundled one, you'll see an error like:
```
The module was compiled against a different Node.js version using
NODE_MODULE_VERSION 115. This version requires NODE_MODULE_VERSION 128.
```
**Fix:** rebuild it specifically for Electron, every time dependencies are installed:
```json
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  }
}
```
(via the `@electron/rebuild` package you installed in `02-tech-stack.md`.)

**Problem 2 — it can't load from inside the packaged app's `asar` archive.** Electron bundles your app into a single compressed `app.asar` file for distribution. Native `.node` binaries cannot be executed directly from inside that archive — they need to sit as real files on disk. **Fix:** explicitly unpack it in your `electron-builder` config:

```json
{
  "build": {
    "asar": true,
    "asarUnpack": [
      "**/node_modules/better-sqlite3/**"
    ],
    "npmRebuild": true
  }
}
```

And one more piece that's easy to miss: your build tool (electron-vite/Vite) will try to bundle `better-sqlite3` into your Main process code like any other import, which breaks it the same way. Mark it **external** in the Main process build config so it's loaded from `node_modules` at runtime instead of bundled:

```typescript
// electron.vite.config.ts
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['better-sqlite3'],
      },
    },
  },
  // ...
});
```

All three pieces — the rebuild step, `asarUnpack`, and marking it external — are needed together. Missing any one of them is the single most common reason "it works in dev but crashes the packaged app" happens with this exact stack.

## Building the Windows installer

```json
{
  "build": {
    "appId": "com.yourbusiness.posapp",
    "productName": "YourRestaurant POS",
    "win": {
      "target": "nsis",
      "icon": "build/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

`npm run build && electron-builder --win` produces a `Setup.exe` — a proper installer with a Start Menu entry, desktop shortcut, and uninstaller, not just a bare `.exe` someone has to know to run correctly.

## Code signing — the honest part

An unsigned Windows installer will trigger a **"Windows protected your PC" / SmartScreen** warning the first time someone runs it, with an "unknown publisher" message that looks alarming even though the app is fine. This is normal and every unsigned app hits it — it is not a bug in what you built. Getting rid of it requires an actual code-signing certificate from a certificate authority (a real yearly cost). For an internal tool used by you and your own staff, most people just click "More info → Run anyway" once and move on, and it's reasonable to defer buying a certificate until/unless this app is going to other restaurants, not just yours.

## Auto-update (optional, not needed for v1)

`electron-updater` (from the same team as `electron-builder`) can check a GitHub Releases page or a static file server on launch and self-update. For a single-restaurant internal tool, this is a "nice to have once you're past the roadmap in `08-roadmap.md`," not a launch requirement — manually building and reinstalling a new version every so often is completely fine while you're the only one maintaining it.

## Dev environment checklist

- Node.js LTS installed
- `npm install` (triggers the `postinstall` rebuild step above automatically)
- `npm run dev` — electron-vite's dev server with hot reload on the Renderer, auto-restart on Main process changes
- Before your first `electron-builder` run, do one clean `rm -rf node_modules && npm install && npm run build && electron-builder --win` on a machine as close to "fresh" as you can manage — catching an asar/native-module issue in your own testing beats catching it from an owner's confused phone call.
