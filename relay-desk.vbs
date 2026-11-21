Option Explicit
Dim shell, files, folder, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
command = "node " & Chr(34) & folder & "\desktop\start.cjs" & Chr(34)
shell.Run command, 0, False
