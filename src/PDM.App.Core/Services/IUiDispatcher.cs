namespace PDM.App.Services;

/// <summary>
/// Marshals an action onto the UI thread. The shared ViewModels and services use this instead of a
/// concrete UI framework's dispatcher so they can run under WPF today and Avalonia later (and inline
/// in headless tests). Implementations must run the action inline when the caller is
/// already on the UI thread (or when there is no UI thread, e.g. tests) and otherwise post it.
/// </summary>
public interface IUiDispatcher
{
    /// <summary>Runs <paramref name="action"/> on the UI thread — inline if already on it, else posted.</summary>
    void Post(Action action);
}

/// <summary>
/// An <see cref="IUiDispatcher"/> that always runs the action inline on the calling thread. Used in
/// headless tests and any context without a real UI thread, matching the pre-migration behaviour
/// where a null <c>Application.Current</c> caused handlers to run inline.
/// </summary>
public sealed class InlineUiDispatcher : IUiDispatcher
{
    /// <summary>Shared instance.</summary>
    public static readonly InlineUiDispatcher Instance = new();

    /// <inheritdoc />
    public void Post(Action action) => action();
}
