# Diagnostic only — not used by the normal paste/copy commands.
# Prints every clipboard format currently present, and for FileMaker's known
# private formats (Mac-XMSS etc.) a hex + text dump of the first bytes, so a
# real FileMaker copy can be compared byte-for-byte against what FM Bridge
# writes on Ctrl+Alt+B. Requires -STA (the caller passes it).

Add-Type -AssemblyName System.Windows.Forms

$knownFormats = @('Mac-XMSS', 'Mac-XMSC', 'Mac-XMTB', 'Mac-XMFD', 'Mac-XMFN', 'Mac-XMVL', 'Mac-XML2')

$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -eq $data) {
    Write-Output 'No data object on clipboard.'
    exit 0
}

$formats = $data.GetFormats()
Write-Output ('All formats present: ' + ($formats -join ', '))
Write-Output ''

foreach ($f in $knownFormats) {
    if (-not $data.GetDataPresent($f)) { continue }
    $obj = $data.GetData($f)
    Write-Output ('--- ' + $f + ' ---')
    Write-Output ('.NET type: ' + $obj.GetType().FullName)

    $bytes = $null
    if ($obj -is [System.IO.MemoryStream]) {
        $bytes = $obj.ToArray()
    } elseif ($obj -is [byte[]]) {
        $bytes = $obj
    } elseif ($obj -is [string]) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($obj)
    }

    if ($null -eq $bytes) {
        Write-Output '(unrecognized data shape, no byte dump available)'
        Write-Output ''
        continue
    }

    Write-Output ('Length: ' + $bytes.Length + ' bytes')
    $head = $bytes[0..([Math]::Min(31, $bytes.Length - 1))]
    Write-Output ('First bytes (hex): ' + (($head | ForEach-Object { $_.ToString('X2') }) -join ' '))
    $sampleLen = [Math]::Min(120, $bytes.Length)
    $asUtf8 = [System.Text.Encoding]::UTF8.GetString($bytes[0..($sampleLen - 1)])
    Write-Output ('First bytes as UTF-8 text: ' + $asUtf8)
    Write-Output ''
}

if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::UnicodeText)) {
    $text = [System.Windows.Forms.Clipboard]::GetText()
    Write-Output ('--- plain text flavor ---')
    Write-Output ('Length: ' + $text.Length + ' chars')
    Write-Output ('Starts with: ' + $text.Substring(0, [Math]::Min(80, $text.Length)))
}
