namespace PDM.Licensing;

/// <summary>
/// The product model a build runs. Both models ship in the same code and the same installer; one
/// constant (<see cref="EditionPolicy.Current"/>) selects between them. See docs/EDITIONS.md.
/// </summary>
public enum ProductEdition
{
    /// <summary>
    /// No licence key: <see cref="LicenseStatus.Community"/>, fully functional with
    /// <see cref="LicenseEntitlements.Community"/> (up to 8 connections per download, no limit on
    /// simultaneous downloads, no expiry). A Premium key shows the Premium plan; a Premium licence
    /// that lapses or is revoked falls back to Community, never to a reduced tier.
    /// </summary>
    Community = 0,

    /// <summary>
    /// The model PDM used up to 1.4: a full-featured 14-day trial, then the reduced
    /// <see cref="LicenseEntitlements.Free"/> tier (2 connections, one download at a time) until a
    /// licence key is activated.
    /// </summary>
    Trial = 1
}

/// <summary>Build-wide edition selection.</summary>
public static class EditionPolicy
{
    /// <summary>
    /// The edition this build runs. Change this one value (and the website text listed in
    /// docs/EDITIONS.md) to switch the whole app between the Community and the Trial model.
    /// </summary>
    public const ProductEdition Current = ProductEdition.Community;
}
