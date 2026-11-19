using Avalonia.Controls;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// First-run welcome shown once to brand-new installs. Its whole job is to make the browser
/// extension discoverable: a new user otherwise has to find Browser setup in the ⋯ menu on their own.
/// The caller reads <see cref="OpenBrowserSetupRequested"/> after it closes and opens the wizard.
/// </summary>
public partial class WelcomeWindow : Window
{
    public WelcomeWindow()
    {
        InitializeComponent();
    }

    /// <summary>True when the user chose "Add browser extension"; the caller then opens the wizard.</summary>
    public bool OpenBrowserSetupRequested { get; private set; }

    private void OnAddExtension(object? sender, RoutedEventArgs e)
    {
        OpenBrowserSetupRequested = true;
        Close();
    }

    private void OnLater(object? sender, RoutedEventArgs e) => Close();
}
