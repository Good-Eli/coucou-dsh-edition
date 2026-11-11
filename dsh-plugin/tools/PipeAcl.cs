// Reads the security descriptor of a Windows named pipe and prints its SDDL.
// Verification tool only: it opens the pipe with READ_CONTROL and asks the OS.
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;

public static class PipeAcl
{
    const uint GENERIC_READ = 0x80000000;
    const uint READ_CONTROL = 0x00020000;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_OVERLAPPED = 0x40000000;
    const int SE_KERNEL_OBJECT = 6;
    const int DACL_SECURITY_INFORMATION = 4;
    const int OWNER_SECURITY_INFORMATION = 1;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share,
        IntPtr sa, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint GetSecurityInfo(IntPtr handle, int type, int info,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr sd, uint revision, int info, out IntPtr sddl, out uint len);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr h);

    public static string Describe(string pipeName)
    {
        IntPtr handle = CreateFileW(pipeName, READ_CONTROL, 0, IntPtr.Zero,
            OPEN_EXISTING, FILE_FLAG_OVERLAPPED, IntPtr.Zero);
        if (handle == new IntPtr(-1))
            return "OPEN_FAILED:" + Marshal.GetLastWin32Error();

        try
        {
            IntPtr owner, group, dacl, sacl, sd;
            uint rc = GetSecurityInfo(handle, SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                out owner, out group, out dacl, out sacl, out sd);
            if (rc != 0) return "GET_FAILED:" + rc;

            try
            {
                IntPtr sddl;
                uint len;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                        sd, 1, DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                        out sddl, out len))
                    return "CONVERT_FAILED:" + Marshal.GetLastWin32Error();

                try { return Marshal.PtrToStringUni(sddl); }
                finally { LocalFree(sddl); }
            }
            finally { LocalFree(sd); }
        }
        finally { CloseHandle(handle); }
    }
}
