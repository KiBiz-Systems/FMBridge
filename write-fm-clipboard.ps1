# Writes a FileMaker snippet to the clipboard under FileMaker's own private
# format, so Script Workspace will accept the paste.
#
# Counterpart to read-fm-clipboard.ps1. FileMaker for Windows registers its
# clipboard formats with the same names it uses on macOS ("Mac-XMSS" for script
# steps, "Mac-XMSC" for whole scripts) and resolves a paste from those; a
# clipboard carrying only CF_UNICODETEXT is ignored without any error, which is
# what made Ctrl+Alt+B look like it had worked while nothing pasted.
#
# v0.1.21 wrote this via [System.Windows.Forms.Clipboard]::SetDataObject, which
# looked like it worked (no exception, .NET could read its own data back) but
# still pasted nothing into FileMaker. v0.1.23 switched to the raw Win32
# clipboard API (user32/kernel32 via P/Invoke) — OpenClipboard, EmptyClipboard,
# GlobalAlloc + GlobalLock + Marshal.Copy + GlobalUnlock, SetClipboardData,
# CloseClipboard — to rule out .NET's marshaling as the culprit. That fixed the
# memory-layout ambiguity but still didn't paste, because the payload shape
# itself was wrong: a hex dump of a REAL FileMaker-for-Windows copy (dumped via
# dump-clipboard.ps1) showed the Mac-XMSS format is not bare XML — it is a
# 4-byte little-endian length header (the XML's byte count, header itself not
# included) immediately followed by the UTF-8 XML, no trailing null. Confirmed
# byte-for-byte: header bytes 74 27 00 00 = 0x00002774 = 10100, and the buffer
# was exactly 10104 bytes (10100 + the 4 header bytes) with `<fmxmlsnippet...`
# starting right at offset 4. FileMaker's paste routine apparently trusts that
# header rather than scanning for the XML (unlike our own read-fm-clipboard.ps1
# /extractSnippet, which tolerate the header only by locating the substring).
#
# The XML arrives as UTF-8 bytes on stdin (not as an argument: the payload is a
# whole script and would overrun the command-line length limit).
#
# Requires -STA for clipboard access (the caller passes it).

param(
    [string]$Format = 'Mac-XMSS'
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace FMBridge -Name Win32Clipboard -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool OpenClipboard(IntPtr hWndNewOwner);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool CloseClipboard();

[DllImport("user32.dll", SetLastError = true)]
public static extern bool EmptyClipboard();

[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

[DllImport("user32.dll", SetLastError = true)]
public static extern uint RegisterClipboardFormat(string lpszFormat);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GlobalLock(IntPtr hMem);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GlobalUnlock(IntPtr hMem);
'@

# GMEM_MOVEABLE | GMEM_ZEROINIT — matches what every Win32 clipboard sample
# uses; the clipboard takes ownership of the handle once SetClipboardData
# succeeds, so it must not be a fixed/local allocation we'd free ourselves.
$GMEM_MOVEABLE = 0x0002
$GMEM_ZEROINIT = 0x0040
$CF_UNICODETEXT = 13

function Set-ClipboardBytes {
    param([uint32]$FormatId, [byte[]]$Bytes)

    $hMem = [FMBridge.Win32Clipboard]::GlobalAlloc($GMEM_MOVEABLE -bor $GMEM_ZEROINIT, [UIntPtr]::new([uint64]$Bytes.Length))
    if ($hMem -eq [IntPtr]::Zero) { throw 'GlobalAlloc failed' }
    $ptr = [FMBridge.Win32Clipboard]::GlobalLock($hMem)
    if ($ptr -eq [IntPtr]::Zero) { throw 'GlobalLock failed' }
    try {
        [System.Runtime.InteropServices.Marshal]::Copy($Bytes, 0, $ptr, $Bytes.Length)
    } finally {
        [FMBridge.Win32Clipboard]::GlobalUnlock($hMem) | Out-Null
    }
    if ([FMBridge.Win32Clipboard]::SetClipboardData($FormatId, $hMem) -eq [IntPtr]::Zero) {
        throw "SetClipboardData failed for format $FormatId"
    }
}

# Read stdin as raw bytes so the payload's encoding is exactly what was sent —
# going through [Console]::In would re-decode it in the console's code page.
$stdin = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$stdin.CopyTo($buffer)
$bytes = $buffer.ToArray()

if ($bytes.Length -eq 0) {
    Write-Error 'no XML received on stdin'
    exit 1
}

$xml = [System.Text.Encoding]::UTF8.GetString($bytes)
$formatId = [FMBridge.Win32Clipboard]::RegisterClipboardFormat($Format)
if ($formatId -eq 0) { throw 'RegisterClipboardFormat failed' }

# Retry OpenClipboard briefly — another process (a clipboard manager, etc.)
# can hold it open for a moment; that is transient, not a real failure.
$opened = $false
for ($i = 0; $i -lt 10 -and -not $opened; $i++) {
    $opened = [FMBridge.Win32Clipboard]::OpenClipboard([IntPtr]::Zero)
    if (-not $opened) { Start-Sleep -Milliseconds 50 }
}
if (-not $opened) { throw 'OpenClipboard failed (clipboard busy)' }

try {
    if (-not [FMBridge.Win32Clipboard]::EmptyClipboard()) { throw 'EmptyClipboard failed' }

    # Plain text first, so the XML stays pasteable into an editor even if the
    # private-format write below fails for some reason.
    $textBytes = [System.Text.Encoding]::Unicode.GetBytes($xml + [char]0)
    Set-ClipboardBytes -FormatId $CF_UNICODETEXT -Bytes $textBytes

    # Prepend the 4-byte little-endian length header FileMaker's own copy
    # output carries (see comment above) — the private format is not bare
    # XML, it is [length header][XML], and FileMaker's paste routine expects
    # that header to be present, not just the XML.
    $lengthHeader = [BitConverter]::GetBytes([uint32]$bytes.Length)
    $withHeader = New-Object byte[] ($lengthHeader.Length + $bytes.Length)
    [Array]::Copy($lengthHeader, 0, $withHeader, 0, $lengthHeader.Length)
    [Array]::Copy($bytes, 0, $withHeader, $lengthHeader.Length, $bytes.Length)
    Set-ClipboardBytes -FormatId $formatId -Bytes $withHeader
} finally {
    [FMBridge.Win32Clipboard]::CloseClipboard() | Out-Null
}

exit 0
