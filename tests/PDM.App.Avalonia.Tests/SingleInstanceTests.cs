using PDM.Platform.Windows;
using Xunit;

namespace PDM.App.Avalonia.Tests;

/// <summary>
/// A second launch asks the running PDM to show its main window. Uses real named kernel objects with
/// a per-test name so a running PDM is never involved.
/// </summary>
public sealed class SingleInstanceTests
{
    [Fact]
    public void Second_launch_asks_the_first_instance_to_show_itself()
    {
        string name = UniqueName();
        using var activated = new ManualResetEventSlim();
        using var first = new SingleInstance(name);
        first.ListenForActivation(activated.Set);

        using var second = new SingleInstance(name);
        Assert.True(first.IsFirstInstance);
        Assert.False(second.IsFirstInstance);

        second.ActivateExisting();

        Assert.True(activated.Wait(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void Request_made_while_the_first_instance_is_still_starting_is_not_lost()
    {
        string name = UniqueName();
        using var activated = new ManualResetEventSlim();
        using var first = new SingleInstance(name);
        using var second = new SingleInstance(name);

        // The first instance only starts listening once its window exists; a launch in between still counts.
        second.ActivateExisting();
        first.ListenForActivation(activated.Set);

        Assert.True(activated.Wait(TimeSpan.FromSeconds(5)));
    }

    private static string UniqueName() => $@"Local\PDM.Tests.SingleInstance.{Guid.NewGuid():N}";
}
