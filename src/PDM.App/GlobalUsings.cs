// Central using directives for the WPF app.
// The default WPF SDK ImplicitUsings set does not include System.IO or System.Net.Http;
// we bring them in here so file/network types are available without per-file imports.
global using System.IO;
global using System.Net.Http;

// Prefer the built-in WPF MessageBox over the WPF-UI one when unqualified. The WPF-UI
// version has a slightly different API and is not needed for our simple validation prompts.
global using MessageBox = System.Windows.MessageBox;
global using MessageBoxButton = System.Windows.MessageBoxButton;
global using MessageBoxImage = System.Windows.MessageBoxImage;

// Because we enable UseWindowsForms (needed for the balloon notification service), the
// WinForms namespaces are pulled in and collide with WPF. Alias the WPF equivalents so
// unqualified references throughout the app resolve to the WPF types.
global using Application = System.Windows.Application;
global using DragEventArgs = System.Windows.DragEventArgs;
global using KeyEventArgs = System.Windows.Input.KeyEventArgs;
global using DataFormats = System.Windows.DataFormats;
global using DragDropEffects = System.Windows.DragDropEffects;
