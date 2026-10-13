# تفعيل البرنامج — Activation

The program runs only on machines you have authorised. This is how you authorise one.

## Once, ever

`license-private.pem` in this folder is the file that authorises every till you will
ever activate. It has already been created.

**Back it up somewhere off this PC and keep it private.** If you lose it, tills that
are already activated keep working, but you can never activate a new one without
shipping a new build. If someone else gets it, they can activate their own copies.

It is git-ignored and is *not* inside the installer — `build.files` in package.json
packages `out/` and the icons, nothing else. Verify any time with:

```
npx asar list "dist-new\win-unpacked\resources\app.asar" | findstr /i license-private
```

That should print nothing.

## Activating a till

1. Install and open the program on the new PC. It shows **تفعيل البرنامج** and
   nothing else — no till, no books, no printing.
2. Read the **رقم الجهاز** off that screen, e.g. `B212-CF00-AA9F-171B-946C`.
   The button on the screen copies it.
3. On **your** PC, in this folder:

   ```
   node tools/license-keygen.mjs sign B212-CF00-AA9F-171B-946C
   ```

4. Send the key it prints to the till and paste it in. Spaces, line breaks and
   dashes do not matter.

The key works on that machine and no other. Each PC needs its own — including the
second till on the LAN, which is not covered by the master's activation.

## What it stops, and what it does not

**Stops:** copying the installed folder, the portable .exe, or a database backup onto
another PC and expecting it to run. The key is an Ed25519 signature over that PC's
own hardware id; the program holds only the public half, so nothing inside it can
mint a key. The check sits on the single choke point every screen goes through
(`src/main/net/router.ts`), so an unactivated PC cannot ring up a sale, read the
books, print, or serve a node — whatever is done to the screens.

**Does not stop:** someone who can patch the executable itself. No check that runs on
the customer's own machine can, and pretending otherwise would only have meant
obfuscation that makes the till harder to support.

**Also does not stop:** a full disk-image clone. `MachineGuid` lives in the registry
and an image carries it, so a cloned disk arrives licensed. This is a deliberate
trade — see below.

## The device id

It is `sha256(MachineGuid)`, truncated to 20 hex characters. One registry read, no
subprocess, no network, no timeout.

MachineGuid is the only source **on purpose**. An earlier version also folded in the
motherboard serial, read by spawning PowerShell. Every way of fetching that can fail
transiently — an eight-second timeout on a machine still booting, antivirus holding
the process, a locked-down execution policy — and a transient failure looks exactly
like a board that has no serial. The id therefore changed shape between boots, and a
till that had been working for weeks would lock *itself* out with a key that no
longer matched. A fingerprint that is not perfectly deterministic is worse than a
weaker one, so the second source is gone.

It survives: reboots, app updates, moving the program folder, restored backups,
changing any hardware, renaming the PC.

It does **not** survive: reinstalling Windows, or a `sysprep` that regenerates the
guid. After either, issue a new key for the new id.

## Where the key is stored

Two places, both written on activation, first one found wins on read:

1. `%ProgramData%\CrispoPOS\license.key` — machine-wide, so every Windows account on
   that till is covered by one activation.
2. `%APPDATA%\resto-pos\license.key` — per-user fallback, for when ProgramData is not
   writable without administrator rights.

That second path is `app.getPath('userData')`, driven by `name` in package.json — not
by the product name, and not the `data\` folder beside the portable exe. Neither
location travels with a copied program folder, which is the point.

If activation reports **المفتاح صحيح لكن تعذر حفظه**, the key verified but neither
location accepted a write. Run the program once as administrator.

## When a licensed PC stops working

Every launch writes the id and the verdict to the log, which is the fastest way to
diagnose a till that will not open:

```
[License] Device B212-CF00-AA9F-171B-946C — activated
```

Log file: `%APPDATA%\resto-pos\logs\main.log`

A line reading `MachineGuid unavailable; falling back to host name` means the registry
read failed and the id is now derived from the PC's name — renaming it will then break
the licence. That should never happen on a normal Windows install; if you see it,
tell me rather than working around it.
