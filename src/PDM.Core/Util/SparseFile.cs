using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace PDM.Core.Util;

/// <summary>
/// Marks a file as <em>sparse</em> on Windows/NTFS. This is a critical optimization for segmented
/// downloads and directly prevents a severe "fast then stalls" failure mode.
///
/// <para><b>Why this matters.</b> A parallel download preallocates the output to its final size and
/// then writes at many scattered offsets at once (segment 0 at byte 0, segment 15 near the end,
/// etc.). On NTFS a file tracks a "valid data length" (VDL); writing beyond the current VDL forces
/// the OS to physically zero every byte between the VDL and the new write offset before the write can
/// proceed. So the connection that writes near the end of the file makes NTFS zero-fill almost the
/// entire file up front. On storage with a throughput cap (typically an Azure/cloud VM disk) that
/// burst of zeroing saturates the disk for seconds, back-pressures the network reads (each read waits
/// on its write), and idle connections then trip the server/receive timeout — the reported symptom of
/// a download that starts fast, collapses to KB/s showing "waiting for server", and eventually fails a
/// segment.</para>
///
/// <para>Marking the file sparse tells NTFS to skip that zero-fill: unwritten regions are simply not
/// allocated and read back as zero with no disk I/O. Once every segment has written, the file is fully
/// populated and behaves like any normal file. The logical length is unchanged, so size checks and the
/// final rename are unaffected.</para>
///
/// <para>Entirely best-effort: on non-Windows platforms, on file systems that do not support sparse
/// files, or if the control call fails for any reason, the download proceeds unchanged (just without
/// this optimization). It is never allowed to fail a download.</para>
/// </summary>
public static class SparseFile
{
    // FSCTL_SET_SPARSE control code (winioctl.h).
    private const uint FSCTL_SET_SPARSE = 0x000900C4;

    /// <summary>
    /// Attempts to mark the file behind <paramref name="handle"/> sparse. No-op off Windows and on any
    /// failure. Call this on a freshly created part file, before preallocating or writing to it.
    /// </summary>
    public static void TryEnable(SafeFileHandle handle)
    {
        if (handle is null || handle.IsInvalid || !OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            // No input/output buffers are needed to set the sparse attribute.
            _ = DeviceIoControl(handle, FSCTL_SET_SPARSE, IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero);
        }
        catch
        {
            // Sparse is a pure optimization; a volume that rejects it (e.g. FAT/exFAT) must not break
            // the download.
        }
    }

    // Classic DllImport (not LibraryImport) so PDM.Core does not need AllowUnsafeBlocks. The signature
    // is fully blittable (SafeFileHandle + integers + IntPtr), so it marshals cleanly and is AOT-safe.
    [SupportedOSPlatform("windows")]
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice,
        uint dwIoControlCode,
        IntPtr lpInBuffer,
        uint nInBufferSize,
        IntPtr lpOutBuffer,
        uint nOutBufferSize,
        out uint lpBytesReturned,
        IntPtr lpOverlapped);
}
