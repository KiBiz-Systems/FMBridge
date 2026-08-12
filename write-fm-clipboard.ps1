# Writes a FileMaker snippet to the clipboard under FileMaker's own private
# format, so Script Workspace will accept the paste.
#
# Counterpart to read-fm-clipboard.ps1. FileMaker for Windows registers its
# clipboard formats with the same names it uses on macOS ("Mac-XMSS" for script
# steps, "Mac-XMSC" for whole scripts) and resolves a paste from those; a
# clipboard carrying only CF_UNICODETEXT is ignored without any error, which is
# what made Ctrl+Alt+B look like it had worked while nothing pasted.
#
# The XML arrives as UTF-8 bytes on stdin (not as an argument: the payload is a
# whole script and would overrun the command-line length limit).
#
# Both flavours are published from one DataObject: the private format for
# FileMaker, plus plain text so the XML stays pasteable into an editor. Requires
# -STA for clipboard access (the caller passes it).

param(
    [string]$Format = 'Mac-XMSS'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

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

# WinForms writes a MemoryStream's bytes to the clipboard verbatim, which is
# what a native reader like FileMaker expects — anything else would be wrapped
# in .NET serialization metadata.
$stream = New-Object System.IO.MemoryStream
$stream.Write($bytes, 0, $bytes.Length)

$data = New-Object System.Windows.Forms.DataObject
$data.SetData($Format, $false, $stream)
$data.SetText($xml)

# $true = leave the data on the clipboard after this process exits.
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
exit 0
