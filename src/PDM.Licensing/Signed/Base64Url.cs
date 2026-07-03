namespace PDM.Licensing.Signed;

/// <summary>Minimal base64url (RFC 4648 §5) encode/decode without external dependencies.</summary>
internal static class Base64Url
{
    public static byte[] Decode(string input)
    {
        string s = input.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
            case 1: throw new FormatException("Invalid base64url length.");
        }

        return Convert.FromBase64String(s);
    }

    public static string Encode(byte[] input)
    {
        return Convert.ToBase64String(input)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }
}
