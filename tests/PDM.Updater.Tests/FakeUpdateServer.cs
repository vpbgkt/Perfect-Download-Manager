using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using PDM.Updater;

namespace PDM.Updater.Tests;

/// <summary>
/// Tiny in-process HTTP handler that serves a signed manifest and an installer payload
/// at fixed URLs. Simulates the update server so the update service can be exercised
/// end-to-end without any network.
/// </summary>
public sealed class FakeUpdateServer : HttpMessageHandler
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly UpdateManifest _manifest;
    private readonly byte[] _package;

    public FakeUpdateServer(UpdateManifest manifest, byte[] package)
    {
        _manifest = manifest;
        _package = package;
    }

    /// <summary>Fixed manifest URL served by this handler.</summary>
    public Uri ManifestUrl { get; } = new("https://updates.pdm.test/manifest.json");

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        HttpResponseMessage response;

        if (request.RequestUri == ManifestUrl)
        {
            string json = JsonSerializer.Serialize(_manifest, JsonOptions);
            response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8)
                {
                    Headers = { ContentType = new MediaTypeHeaderValue("application/json") }
                }
            };
        }
        else if (request.RequestUri == _manifest.PackageUrl)
        {
            response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(_package)
                {
                    Headers = { ContentType = new MediaTypeHeaderValue("application/octet-stream") }
                }
            };
            response.Content.Headers.ContentLength = _package.LongLength;
        }
        else
        {
            response = new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        response.RequestMessage = request;
        return Task.FromResult(response);
    }
}
