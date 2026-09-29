# Shows one Windows balloon, then exits. Title and body arrive URL-encoded so
# any text, including non-ASCII, survives the command line intact.
param(
    [string]$Title = 'idle-compact',
    [string]$Body = ''
)

$Title = [System.Uri]::UnescapeDataString($Title)
$Body = [System.Uri]::UnescapeDataString($Body)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.BalloonTipTitle = $Title
$notify.BalloonTipText = $Body
$notify.ShowBalloonTip(5000)

# The balloon disappears with this process, so keep it up for a moment.
Start-Sleep -Seconds 6
$notify.Dispose()
