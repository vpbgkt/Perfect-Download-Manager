using System.Windows;

namespace PDM.App.Services;

/// <summary>
/// WPF implementation of <see cref="IUiDispatcher"/>. Marshals onto the application dispatcher,
/// running inline when already on the UI thread or when no application dispatcher exists (headless
/// contexts). This preserves the exact pre-migration behaviour that lived in
/// <c>MainViewModel.RunOnUi</c> / <c>PopupManager.RunOnUi</c>.
/// </summary>
public sealed class WpfUiDispatcher : IUiDispatcher
{
    /// <inheritdoc />
    public void Post(Action action)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess())
        {
            action();
        }
        else
        {
            dispatcher.BeginInvoke(action);
        }
    }
}
