param([string]$HandleFile, [int]$TestProcess)
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System.Runtime.InteropServices; public static class ForegroundGrant {
  [DllImport("user32")] public static extern bool AllowSetForegroundWindow(int process);
}'
$form = New-Object Windows.Forms.Form
$form.Text = 'Suiban selection fixture'
$edit = New-Object Windows.Forms.TextBox
$edit.Text = 'before selected-123 after'
$form.Controls.Add($edit)
$form.Add_Shown({
  $form.Activate()
  $edit.Focus()
  $edit.Select(7, 12)
  [void][ForegroundGrant]::AllowSetForegroundWindow($TestProcess)
  [IO.File]::WriteAllText($HandleFile, $form.Handle.ToInt64().ToString())
})
[Windows.Forms.Application]::Run($form)
