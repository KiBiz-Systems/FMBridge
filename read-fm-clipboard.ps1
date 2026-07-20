# Reads FileMaker's private clipboard formats and prints the XML snippet to stdout.
# FileMaker registers formats like Mac-XMSS (script steps), Mac-XMSC (scripts),
# Mac-XMTB (tables), Mac-XMFD (fields), Mac-XMFN (custom functions), Mac-XMVL (value lists).
# The payload is UTF-8 XML, sometimes with a 4-byte length header before it.
# Requires -STA (the caller passes it).

Add-Type -AssemblyName System.Windows.Forms

$formats = @('Mac-XMSS', 'Mac-XMSC', 'Mac-XMTB', 'Mac-XMFD', 'Mac-XMFN', 'Mac-XMVL', 'Mac-XML2')

foreach ($f in $formats) {
    try {
        $data = [System.Windows.Forms.Clipboard]::GetData($f)
    } catch {
        continue
    }
    if ($null -eq $data) { continue }
    $bytes = $null
    if ($data -is [System.IO.MemoryStream]) {
        $bytes = $data.ToArray()
    } elseif ($data -is [byte[]]) {
        $bytes = $data
    } elseif ($data -is [string]) {
        $i = $data.IndexOf('<fmxmlsnippet')
        if ($i -ge 0) { Write-Output $data.Substring($i); exit 0 }
        continue
    }
    if ($null -eq $bytes) { continue }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $i = $text.IndexOf('<fmxmlsnippet')
    if ($i -ge 0) {
        $end = $text.IndexOf('</fmxmlsnippet>', $i)
        if ($end -ge 0) {
            Write-Output $text.Substring($i, $end + 15 - $i)
            exit 0
        }
    }
}
exit 1
