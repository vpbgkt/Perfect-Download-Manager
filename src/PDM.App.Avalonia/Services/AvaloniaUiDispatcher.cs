using Avalonia.Threading;
using PDM.App.Services;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Avalonia implementation of <see cref="IUiDispatcher"/>. Runs inline when already on the UI thread,
/// otherwise posts to Avalonia's UI-thread dispatcher — the cross-platform equivalent of the WPF
/// head's <c>WpfUiDispatcher</c>.
/// </summary>
public sealed class AvaloniaUiDispatcher : IUiDispatcher
{
    /// <inheritdoc />
    public void Post(Action action)
    {
        if (Dispatcher.UIThread.CheckAccess())
        {
            action();
        }
        else
        {
            Dispatcher.UIThread.Post(action);
        }
    }
}
