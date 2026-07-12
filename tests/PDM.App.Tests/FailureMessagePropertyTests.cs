using System.Reflection;
using FsCheck;
using FsCheck.Fluent;
using FsCheck.Xunit;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

// Feature: idm-style-download-windows, Property 12: Failure message content

/// <summary>
/// Property-based tests verifying that <see cref="DownloadPopupViewModel.FailureMessage"/>
/// correctly reflects the failure state: showing the recorded error when present, a non-empty
/// generic message when no error is recorded, and null when not in the Failed state.
/// </summary>
public sealed class FailureMessagePropertyTests
{
    /// <summary>
    /// **Validates: Requirements 8.2, 8.3**
    ///
    /// For any <see cref="DownloadState"/> with Status == Failed and a non-blank ErrorMessage,
    /// the FailureMessage equals the recorded error, IsFailed is true, CanResume is true,
    /// and CanPause is false.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property FailureMessage_WhenFailed_WithRecordedError_ReturnsError(DownloadState state)
    {
        bool isFailed = state.Status == DownloadStatus.Failed;
        bool hasRecordedError = !string.IsNullOrWhiteSpace(state.ErrorMessage);

        if (!isFailed || !hasRecordedError)
            return true.ToProperty(); // vacuously true — precondition not met

        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(managed);

        bool messageMatches = vm.FailureMessage == state.ErrorMessage;
        bool isFailedFlag = vm.IsFailed;
        bool canResume = vm.CanResume;
        bool cannotPause = !vm.CanPause;

        return (messageMatches && isFailedFlag && canResume && cannotPause).ToProperty()
            .Label($"FailureMessage='{vm.FailureMessage}' expected='{state.ErrorMessage}', IsFailed={vm.IsFailed}, CanResume={vm.CanResume}, CanPause={vm.CanPause}");
    }

    /// <summary>
    /// **Validates: Requirements 8.2, 8.3**
    ///
    /// For any <see cref="DownloadState"/> with Status == Failed and a blank/null ErrorMessage,
    /// the FailureMessage is a non-empty generic message and IsFailed is true.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property FailureMessage_WhenFailed_WithNoError_ReturnsGenericMessage(DownloadState state)
    {
        bool isFailed = state.Status == DownloadStatus.Failed;
        bool hasNoRecordedError = string.IsNullOrWhiteSpace(state.ErrorMessage);

        if (!isFailed || !hasNoRecordedError)
            return true.ToProperty(); // vacuously true — precondition not met

        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(managed);

        bool messageNotNull = vm.FailureMessage != null;
        bool messageNotEmpty = vm.FailureMessage?.Length > 0;
        bool isFailedFlag = vm.IsFailed;

        return (messageNotNull && messageNotEmpty && isFailedFlag).ToProperty()
            .Label($"FailureMessage='{vm.FailureMessage}', IsFailed={vm.IsFailed}");
    }

    /// <summary>
    /// **Validates: Requirements 8.2, 8.3**
    ///
    /// For any <see cref="DownloadState"/> with Status != Failed, FailureMessage is null.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property FailureMessage_WhenNotFailed_ReturnsNull(DownloadState state)
    {
        bool isNotFailed = state.Status != DownloadStatus.Failed;

        if (!isNotFailed)
            return true.ToProperty(); // vacuously true — precondition not met

        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(managed);

        return (vm.FailureMessage == null).ToProperty()
            .Label($"Expected null FailureMessage when not failed, got '{vm.FailureMessage}' for status={state.Status}");
    }

    #region Helpers

    /// <summary>
    /// Creates a <see cref="ManagedDownload"/> via reflection since the constructor is internal.
    /// </summary>
    private static ManagedDownload CreateManagedDownload(DownloadState state)
    {
        var ctor = typeof(ManagedDownload).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: new[] { typeof(DownloadState) },
            modifiers: null)!;

        return (ManagedDownload)ctor.Invoke(new object[] { state });
    }

    #endregion
}
