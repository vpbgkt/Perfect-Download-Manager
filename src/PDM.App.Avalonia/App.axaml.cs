using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using PDM.App.Avalonia.Services;
using PDM.App.ViewModels;
using PDM.App.Avalonia.Views;
using PDM.Core.Util;
using PDM.Licensing;

namespace PDM.App.Avalonia;

/// <summary>
/// The Avalonia <see cref="Application"/>. Builds the shared composition root (<see cref="AppHost"/>)
/// with the Windows platform implementations, creates the main window bound to the shared
/// <see cref="MainViewModel"/>, and disposes the host on shutdown.
/// </summary>
public partial class App : Application
{
    private AppHost? _host;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var notifier = new AvaloniaNotifier();

            // The composition root does only local work on startup (no network), and uses
            // ConfigureAwait(false) throughout, so blocking here does not deadlock the UI thread and
            // mirrors the WPF head's synchronous startup.
            var licenseStore = new DpapiLicenseStore(AppPaths.LicenseFile);
            _host = AppHost.CreateAsync(notifier, licenseStore).GetAwaiter().GetResult();

            var mainViewModel = new MainViewModel(_host, new AvaloniaUiDispatcher());
            desktop.MainWindow = new MainWindow(mainViewModel, notifier);

            desktop.ShutdownRequested += (_, _) =>
            {
                mainViewModel.Dispose();
                _host?.DisposeAsync().AsTask().GetAwaiter().GetResult();
                _host = null;
            };
        }

        base.OnFrameworkInitializationCompleted();
    }
}
