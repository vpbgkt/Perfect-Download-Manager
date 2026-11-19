namespace PDM.Licensing;

/// <summary>Coarse licensing state for the running application.</summary>
public enum LicenseStatus
{
    /// <summary>The trial period is still active; the app is fully functional.</summary>
    Trial = 0,

    /// <summary>The trial expired but a short grace period is still in effect.</summary>
    Grace = 1,

    /// <summary>Trial and grace period have both expired; features that require a license should be locked.</summary>
    Expired = 2,

    /// <summary>A valid, activated license is present.</summary>
    Activated = 3,

    /// <summary>A license exists but validation failed (e.g. revoked or moved to another device).</summary>
    Invalid = 4,

    /// <summary>
    /// No (working) Premium licence in the <see cref="ProductEdition.Community"/> edition: fully
    /// functional with the Community entitlements. Replaces Trial / Expired / Invalid in that edition;
    /// a lapsed or rejected Premium licence also lands here, with the reason in the snapshot message.
    /// </summary>
    Community = 5
}
