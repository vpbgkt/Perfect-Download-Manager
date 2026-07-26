using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Styling;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Applies the user's appearance preferences to the running Avalonia application:
/// <list type="bullet">
/// <item>the theme variant ("system" / "light" / "dark") via <see cref="Application.RequestedThemeVariant"/>, and</item>
/// <item>the accent colour by replacing the accent brush tokens (defined in Theme/Tokens.axaml).</item>
/// </list>
/// Every view references these through <c>DynamicResource</c>, so switching either preference
/// recolours the whole UI live with no restart. Called once at startup from the saved settings and
/// again whenever the user changes a value in Settings (including live preview).
/// </summary>
public static class ThemeApplier
{
    /// <summary>Accent presets shown in Settings. Key = stored id, value = base colour.</summary>
    public static readonly IReadOnlyList<(string Id, string Label)> Accents = new[]
    {
        ("blue", "Blue"),
        ("purple", "Purple"),
        ("green", "Green"),
        ("orange", "Orange"),
        ("pink", "Pink"),
        ("red", "Red"),
        ("teal", "Teal"),
    };

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

    /// <summary>
    /// Applies the accent preset by id, replacing the accent brush tokens so every accent-driven
    /// surface (primary buttons, progress bars, selection highlights, focus) recolours instantly.
    /// </summary>
    public static void ApplyAccent(string? accent)
    {
        if (Application.Current is null)
        {
            return;
        }

        Color baseColor = ResolveAccent(accent);
        IResourceDictionary res = Application.Current.Resources;

        res["AppAccentColor"] = baseColor;
        res["AppAccentBrush"] = new SolidColorBrush(baseColor);
        res["AppAccentHoverBrush"] = new SolidColorBrush(Shade(baseColor, -0.10));
        res["AppAccentPressedBrush"] = new SolidColorBrush(Shade(baseColor, -0.20));
        res["AppAccentSubtleBrush"] = new SolidColorBrush(baseColor, 0.14);
        res["AppOnAccentBrush"] = new SolidColorBrush(OnAccent(baseColor));

        // Also nudge Fluent's native accent so any control still using the built-in "accent" class
        // roughly matches the chosen accent at startup.
        res["SystemAccentColor"] = baseColor;
        res["SystemAccentColorLight1"] = Shade(baseColor, 0.18);
        res["SystemAccentColorLight2"] = Shade(baseColor, 0.36);
        res["SystemAccentColorLight3"] = Shade(baseColor, 0.54);
        res["SystemAccentColorDark1"] = Shade(baseColor, -0.14);
        res["SystemAccentColorDark2"] = Shade(baseColor, -0.28);
        res["SystemAccentColorDark3"] = Shade(baseColor, -0.42);
    }

    /// <summary>Resolves an accent preset id to its base colour (used by the Settings swatches).</summary>
    public static Color ResolveAccent(string? accent) => (accent ?? "blue").ToLowerInvariant() switch
    {
        "purple" => Color.FromRgb(0x8B, 0x5C, 0xF6),
        "green" => Color.FromRgb(0x10, 0xB9, 0x81),
        "orange" => Color.FromRgb(0xF5, 0x9E, 0x0B),
        "pink" => Color.FromRgb(0xEC, 0x48, 0x99),
        "red" => Color.FromRgb(0xEF, 0x44, 0x44),
        "teal" => Color.FromRgb(0x14, 0xB8, 0xA6),
        _ => Color.FromRgb(0x3B, 0x82, 0xF6), // blue
    };

    /// <summary>Lightens (positive amount) or darkens (negative) a colour by blending toward white/black.</summary>
    private static Color Shade(Color c, double amount)
    {
        if (amount >= 0)
        {
            return Color.FromArgb(c.A,
                Blend(c.R, 255, amount),
                Blend(c.G, 255, amount),
                Blend(c.B, 255, amount));
        }

        double a = -amount;
        return Color.FromArgb(c.A,
            Blend(c.R, 0, a),
            Blend(c.G, 0, a),
            Blend(c.B, 0, a));
    }

    private static byte Blend(byte from, int to, double amount) =>
        (byte)Math.Clamp(from + (to - from) * amount, 0, 255);

    /// <summary>Picks a readable on-accent foreground (white/near-black) from the accent's luminance.</summary>
    private static Color OnAccent(Color c)
    {
        // Rec. 601 relative luminance; bright accents (e.g. orange) get dark text.
        double luminance = (0.299 * c.R + 0.587 * c.G + 0.114 * c.B) / 255.0;
        return luminance > 0.62 ? Color.FromRgb(0x10, 0x18, 0x28) : Colors.White;
    }
}
