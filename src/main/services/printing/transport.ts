/**
 * Getting a finished block of ESC/POS bytes onto a printer.
 *
 * Two routes:
 *   - `sendToNetwork` — a plain TCP socket to port 9100. This is what a printer with
 *     its own IP address speaks, and it needs no driver installed at all.
 *   - `sendToWindowsPrinter` — the RAW datatype through the Windows spooler, so a
 *     USB printer installed with the XPrinter driver still receives our exact bytes
 *     instead of a rendered page. Keeping the bytes intact is what preserves the
 *     cut and the cash-drawer kick.
 */

import { app } from 'electron'
import log from 'electron-log/main'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** A till cannot hang waiting on a printer that has been switched off. */
const NETWORK_TIMEOUT_MS = 6000
const SPOOL_TIMEOUT_MS = 20000

export async function sendToNetwork(
  host: string,
  port: number,
  payload: Buffer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      err ? reject(err) : resolve()
    }

    socket.setTimeout(NETWORK_TIMEOUT_MS)
    socket.once('timeout', () => finish(new Error(`لا يوجد رد من الطابعة على ${host}:${port}`)))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const reason = err.code === 'ECONNREFUSED'
        ? `الطابعة على ${host}:${port} رفضت الاتصال`
        : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH'
          ? `تعذر الوصول إلى الطابعة على ${host}`
          : err.message
      finish(new Error(reason))
    })

    socket.connect(port, host, () => {
      // end() flushes what is buffered and then half-closes; 'close' tells us the
      // bytes actually left the machine rather than merely entering a queue.
      socket.end(payload)
    })
    socket.once('close', (hadError) => {
      if (!hadError) finish()
    })
  })
}

/**
 * Check a network printer answers, without printing anything.
 * Used by the settings screen so a wrong IP is caught while someone is looking at it.
 */
export async function probeNetwork(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      err ? reject(err) : resolve()
    }
    socket.setTimeout(NETWORK_TIMEOUT_MS)
    socket.once('timeout', () => finish(new Error(`لا يوجد رد من ${host}:${port}`)))
    socket.once('error', () => finish(new Error(`تعذر الاتصال بالطابعة على ${host}:${port}`)))
    socket.connect(port, host, () => finish())
  })
}

/**
 * The Windows spooler will pass bytes through untouched, but only via the printing
 * API — there is no command-line tool that does it. This script P/Invokes the four
 * winspool calls that open a RAW job and write to it, which is the documented way
 * and needs nothing installed beyond the .NET Framework every Windows already has.
 */
const RAW_PRINT_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$FilePath
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RestoRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOW
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static void Send(string printerName, byte[] bytes)
    {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ")");
        try
        {
            DOCINFOW di = new DOCINFOW();
            di.pDocName = "Resto POS Ticket";
            di.pDataType = "RAW";
            if (!StartDocPrinter(hPrinter, 1, di))
                throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
            try
            {
                if (!StartPagePrinter(hPrinter))
                    throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
                IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);
                try
                {
                    Marshal.Copy(bytes, 0, buffer, bytes.Length);
                    int written;
                    if (!WritePrinter(hPrinter, buffer, bytes.Length, out written))
                        throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
                    if (written != bytes.Length)
                        throw new Exception("WritePrinter wrote " + written + " of " + bytes.Length + " bytes");
                }
                finally { Marshal.FreeCoTaskMem(buffer); }
                EndPagePrinter(hPrinter);
            }
            finally { EndDocPrinter(hPrinter); }
        }
        finally { ClosePrinter(hPrinter); }
    }
}
"@
[RestoRawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($FilePath))
Write-Output "OK"
`

let scriptPath: string | null = null

/**
 * Write the helper next to the app's own data rather than running it off stdin.
 * Piping a script into PowerShell trips several endpoint-protection products, and a
 * blocked receipt printer on a Friday night is not a good way to find that out.
 */
function ensureScript(): string {
  const target = path.join(app.getPath('userData'), 'print', 'raw-print.ps1')
  if (scriptPath === target && fs.existsSync(target)) return target

  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Rewritten every launch: an upgrade that changes the script must not be left
  // running last version's copy.
  fs.writeFileSync(target, RAW_PRINT_PS1, 'utf8')
  scriptPath = target
  return target
}

export async function sendToWindowsPrinter(
  deviceName: string,
  payload: Buffer,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('الطباعة عبر طابعات ويندوز متاحة على ويندوز فقط')
  }

  const script = ensureScript()
  const dataDir = path.join(app.getPath('temp'), 'resto-pos-print')
  fs.mkdirSync(dataDir, { recursive: true })
  const dataFile = path.join(dataDir, `job-${randomUUID()}.bin`)
  fs.writeFileSync(dataFile, payload)

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-PrinterName', deviceName,
        '-FilePath', dataFile,
      ], { windowsHide: true })

      let stderr = ''
      let done = false
      const finish = (err?: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        err ? reject(err) : resolve()
      }

      const timer = setTimeout(() => {
        child.kill()
        finish(new Error(`انتهت مهلة الإرسال إلى الطابعة "${deviceName}"`))
      }, SPOOL_TIMEOUT_MS)

      child.stderr.on('data', (d) => { stderr += String(d) })
      child.once('error', (err) => finish(new Error(`تعذر تشغيل خدمة الطباعة: ${err.message}`)))
      child.once('close', (code) => {
        if (code === 0) return finish()
        const detail = stderr.trim().split('\n')[0] || `رمز الخروج ${code}`
        finish(new Error(`تعذر الإرسال إلى الطابعة "${deviceName}": ${detail}`))
      })
    })
  } finally {
    try { fs.unlinkSync(dataFile) } catch { /* temp file; not worth failing a sale over */ }
  }
}

/** Delete any job/ticket files a crash left behind. Cheap, and runs once at startup. */
export function cleanPrintTemp(): void {
  const dir = path.join(app.getPath('temp'), 'resto-pos-print')
  try {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, name)) } catch { /* in use by another instance */ }
    }
  } catch (err) {
    log.debug('[Print] Temp cleanup skipped:', err)
  }
}
