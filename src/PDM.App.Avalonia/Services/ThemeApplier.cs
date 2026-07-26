using Avalonia;
using Avalonia.Styling;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Applies the user's saved theme preference ("system" / "light" / "dark") to the running Avalonia
/// application by setting <see cref="Application.RequestedThemeVariant"/>. Because every view uses
/// theme-aware Fluent brushes, switching the variant recolors the whole UI live. Called once at
/// startup (from the saved setting) and again whenever the user changes it in Settings.
/// </summary>
public static class ThemeApplier
{
    public static void Apply(string? theme)
    {
        if (Application.Current is null)
        {
            return;
        }

        Application.Current.RequestedThemeVariant = (theme ?? "system").ToLowerInvariant() switch
        {
            "light" => ThemeVariant.Light,
            "dark" => ThemeVariant.Dark,
            _ => ThemeVariant.Default // follow the OS
        };
    }
}
