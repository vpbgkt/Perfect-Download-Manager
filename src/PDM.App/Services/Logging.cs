using Microsoft.Extensions.Logging;
using PDM.Core.Util;
using Serilog;
using Serilog.Events;
using Serilog.Extensions.Logging;

namespace PDM.App.Services;

/// <summary>
/// Configures Serilog with a rolling file sink under <see cref="AppPaths.LogsDirectory"/>
/// and returns an <see cref="ILoggerFactory"/> the rest of the app can use through the
/// <c>Microsoft.Extensions.Logging</c> abstractions. A single file per day is kept for
/// a bounded window so logs never grow unbounded on long-lived installs.
/// </summary>
public static class Logging
{
    /// <summary>
    /// Builds an <see cref="ILoggerFactory"/> writing to file + console. Must be disposed on shutdown.
    /// </summary>
    public static ILoggerFactory Configure()
    {
        string path = Path.Combine(AppPaths.LogsDirectory, "pdm-.log");

        var serilog = new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("System.Net.Http", LogEventLevel.Warning)
            .Enrich.WithProperty("Application", "PDM")
            .WriteTo.File(
                path,
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 14,
                fileSizeLimitBytes: 20L * 1024 * 1024,
                rollOnFileSizeLimit: true,
                shared: true,
                flushToDiskInterval: TimeSpan.FromSeconds(2),
                outputTemplate:
                    "{Timestamp:yyyy-MM-dd HH:mm:ss.fff} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}")
            .WriteTo.Console(
                outputTemplate: "[{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}")
            .CreateLogger();

        Log.Logger = serilog;
        return new SerilogLoggerFactory(serilog, dispose: true);
    }
}
