using System;
using System.IO;
using Windows.Media.Control;
using Windows.Storage.Streams;

class Bridge
{
    static GlobalSystemMediaTransportControlsSessionManager manager;

    static string Esc(string s)
    {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"")
                .Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
    }

    static string GetThumbnailBase64(GlobalSystemMediaTransportControlsSessionMediaProperties props)
    {
        try
        {
            var thumb = props.Thumbnail;
            if (thumb == null) return null;
            var stream = thumb.OpenReadAsync().GetAwaiter().GetResult();
            using (var netStream = stream.AsStreamForRead())
            using (var ms = new MemoryStream())
            {
                netStream.CopyTo(ms);
                string mime = stream.ContentType;
                if (string.IsNullOrEmpty(mime)) mime = "image/jpeg";
                return "data:" + mime + ";base64," + Convert.ToBase64String(ms.ToArray());
            }
        }
        catch { return null; }
    }

    static string GetState()
    {
        string title = "", artist = "", album = "", status = "", source = "", thumb = "";
        bool has = false;
        try
        {
            var s = manager.GetCurrentSession();
            if (s != null)
            {
                has = true;
                var props = s.TryGetMediaPropertiesAsync().GetAwaiter().GetResult();
                var pb = s.GetPlaybackInfo();
                title = props.Title ?? "";
                artist = props.Artist ?? "";
                album = props.AlbumTitle ?? "";
                status = pb.PlaybackStatus.ToString();
                source = s.SourceAppUserModelId ?? "";
                thumb = GetThumbnailBase64(props) ?? "";
            }
        }
        catch { }
        return "{\"hasSession\":" + (has ? "true" : "false") +
               ",\"title\":\"" + Esc(title) + "\"" +
               ",\"artist\":\"" + Esc(artist) + "\"" +
               ",\"album\":\"" + Esc(album) + "\"" +
               ",\"status\":\"" + Esc(status) + "\"" +
               ",\"source\":\"" + Esc(source) + "\"" +
               ",\"thumbnail\":\"" + (thumb ?? "") + "\"}";
    }

    static void Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        manager = GlobalSystemMediaTransportControlsSessionManager.RequestAsync().GetAwaiter().GetResult();
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim().ToLower();
            var s = manager.GetCurrentSession();
            switch (line)
            {
                case "get": Console.WriteLine(GetState()); break;
                case "play": if (s != null) s.TryPlayAsync().GetAwaiter().GetResult(); Console.WriteLine(GetState()); break;
                case "pause": if (s != null) s.TryPauseAsync().GetAwaiter().GetResult(); Console.WriteLine(GetState()); break;
                case "next": if (s != null) s.TrySkipNextAsync().GetAwaiter().GetResult(); Console.WriteLine(GetState()); break;
                case "prev": if (s != null) s.TrySkipPreviousAsync().GetAwaiter().GetResult(); Console.WriteLine(GetState()); break;
                case "toggle": if (s != null) s.TryTogglePlayPauseAsync().GetAwaiter().GetResult(); Console.WriteLine(GetState()); break;
                case "quit": return;
                default: Console.WriteLine(GetState()); break;
            }
            Console.Out.Flush();
        }
    }
}
