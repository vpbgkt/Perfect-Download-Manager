using System.Runtime.Versioning;
using Avalonia.Controls;
using Avalonia.Platform;
using Avalonia.Threading;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Keeps a window in front of the user when it appears because of something that happened in another
/// app (a download captured from the browser, or a download finishing), then lets it behave like a
/// normal window once the user moves on.
/// <para>
/// <see cref="Raise"/> pins the window topmost, which needs no foreground rights, and takes the
/// foreground (<see cref="WindowForeground.TryTakeForeground"/>) so the window is active and ready
/// for the keyboard. The pin is what keeps it visible: the browser rearranges its own windows right
/// after it hands a download over (the extension cancels and erases its copy once PDM accepts), and
/// that used to cover a window that had only been raised once.
/// </para>
/// <para>
/// The pin is released when the user switches to another window, and this window then goes behind
/// the one they picked. If it never became active (Windows refused the foreground), the pin is
/// dropped after <see cref="UnattendedPinDuration"/> instead, which leaves it above the normal
/// windows but no longer above everything.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AttentionPin
{
    /// <summary>How long a window that never became active stays pinned above everything.</summary>
    public static readonly TimeSpan UnattendedPinDuration = TimeSpan.FromSeconds(8);

    private static readonly Uri IconUri = new("avares://PDM/Assets/pdm.ico");

    private readonly Window _window;
    private readonly DispatcherTimer _unattendedTimer;
    private bool _pinned;
    private bool _closed;

    // Bumped on every Raise so a release queued by an earlier deactivation cannot drop a newer pin.
    private int _generation;

    public AttentionPin(Window window)
    {
        _window = window ?? throw new ArgumentNullException(nameof(window));
        _unattendedTimer = new DispatcherTimer { Interval = UnattendedPinDuration };
        _unattendedTimer.Tick += OnUnattendedTimeout;
        _window.Deactivated += OnDeactivated;
        _window.Closed += OnClosed;
    }

    /// <summary>Brings the window in front of every other window and pins it there (see the class remarks).</summary>
    public void Raise()
    {
        // A repeat capture can ask for a prompt that is closing at that moment.
        if (_closed)
        {
            return;
        }

        if (_window.WindowState == WindowState.Minimized)
        {
            _window.WindowState = WindowState.Normal;
        }

        _generation++;
        _pinned = true;
        _window.Topmost = true;
        WindowForeground.TryTakeForeground(_window);
        _window.Activate();

        _unattendedTimer.Stop();
        _unattendedTimer.Start();
    }

    /// <summary>
    /// Shows the window as its own top-level window (no owner), raised in front of the user, and
    /// completes with <paramref name="result"/>, read on the UI thread, once it closes.
    /// <para>
    /// Browser-capture prompts used to be modal dialogs owned by the main window. Windows keeps an
    /// owned window and its owner together, so the whole dashboard came up with every prompt and was
    /// activated again when it closed. A minimized dashboard also hid the prompt, and a hidden or
    /// closed one stopped it from opening at all.
    /// </para>
    /// </summary>
    public Task<T> ShowUnownedAsync<T>(Func<T> result)
    {
        ArgumentNullException.ThrowIfNull(result);

        var closed = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _window.WindowStartupLocation = WindowStartupLocation.CenterScreen;

        // Without an owner the window needs its own taskbar button, so the user can find it again.
        _window.ShowInTaskbar = true;
        _window.Icon ??= LoadIcon();

        _window.Opened += (_, _) => Raise();
        _window.Closed += (_, _) => closed.TrySetResult(result());
        _window.Show();
        return closed.Task;
    }

    /// <summary>Shows the window as its own top-level window (see <see cref="ShowUnownedAsync{T}"/>) when there is no result to read back.</summary>
    public Task ShowUnownedAsync() => ShowUnownedAsync(static () => true);

    private void OnDeactivated(object? sender, EventArgs e)
    {
        if (!_pinned)
        {
            return;
        }

        // Deactivation arrives while Windows is still activating the window the user clicked. Release
        // once that has settled, so this window can go behind it rather than back on top of it.
        int generation = _generation;
        Dispatcher.UIThread.Post(() =>
        {
            if (generation == _generation)
            {
                Release(placeBehindForeground: true);
            }
        }, DispatcherPriority.Background);
    }

    private void OnUnattendedTimeout(object? sender, EventArgs e)
    {
        _unattendedTimer.Stop();

        // While the window is active the user is on it, and Deactivated releases the pin when they leave.
        if (!_window.IsActive)
        {
            Release(placeBehindForeground: false);
        }
    }

    private void Release(bool placeBehindForeground)
    {
        _unattendedTimer.Stop();
        if (!_pinned)
        {
            return;
        }

        _pinned = false;
        _window.Topmost = false;
        if (placeBehindForeground)
        {
            WindowForeground.PlaceBehindForeground(_window);
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _closed = true;
        _unattendedTimer.Stop();
        _unattendedTimer.Tick -= OnUnattendedTimeout;
        _window.Deactivated -= OnDeactivated;
        _window.Closed -= OnClosed;
    }

    private static WindowIcon? LoadIcon()
    {
        try
        {
            return new WindowIcon(AssetLoader.Open(IconUri));
        }
        catch (Exception)
        {
            // Icon is cosmetic; a missing asset must never stop a prompt from opening.
            return null;
        }
    }
}
