Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electron = fso.BuildPath(root, "node_modules\electron\dist\electron.exe")
nodePath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\node.exe")

If Not fso.FileExists(electron) Then
  shell.Popup "Papatya kaynak kurulumunda Electron bulunamadi." & vbCrLf & vbCrLf & _
              "Node.js kurulu degilse once onu kur: https://nodejs.org/" & vbCrLf & _
              "Sonra proje klasorunde npm install calistir.", 0, "Papatya", 48
  WScript.Quit 1
End If

On Error Resume Next
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

shell.CurrentDirectory = root
shell.Run """" & electron & """ .", 1, False
