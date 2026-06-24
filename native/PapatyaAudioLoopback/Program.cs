using NAudio.Wave;

if (args.Length < 4)
{
    Console.Error.WriteLine("Usage: PapatyaAudioLoopback <outputDir> <sessionId> <segmentMs> <keepSeconds>");
    return 2;
}

var outputDir = args[0];
var sessionId = args[1];
var segmentMs = Math.Max(250, int.Parse(args[2]));
var keepSeconds = Math.Max(10, int.Parse(args[3]));
Directory.CreateDirectory(outputDir);

using var capture = new WasapiLoopbackCapture();
var stop = false;
var index = 0;
var sync = new object();
WaveFileWriter? writer = null;
DateTime segmentStartedAt = DateTime.UtcNow;

void CleanupOldSegments()
{
    var cutoff = DateTime.UtcNow.AddSeconds(-keepSeconds);
    foreach (var file in Directory.EnumerateFiles(outputDir, $"{sessionId}-*.wav"))
    {
        try
        {
            if (File.GetLastWriteTimeUtc(file) < cutoff) File.Delete(file);
        }
        catch
        {
        }
    }
}

void CloseWriter()
{
    writer?.Dispose();
    writer = null;
}

void OpenWriter()
{
    CloseWriter();
    CleanupOldSegments();
    segmentStartedAt = DateTime.UtcNow;
    var filePath = Path.Combine(outputDir, $"{sessionId}-{index++:D6}.wav");
    writer = new WaveFileWriter(filePath, capture.WaveFormat);
    Console.WriteLine($"segment {filePath}");
}

capture.DataAvailable += (_, eventArgs) =>
{
    lock (sync)
    {
        if (stop) return;
        if (writer == null) OpenWriter();
        writer!.Write(eventArgs.Buffer, 0, eventArgs.BytesRecorded);
        writer.Flush();
        if ((DateTime.UtcNow - segmentStartedAt).TotalMilliseconds >= segmentMs)
        {
            OpenWriter();
        }
    }
};

capture.RecordingStopped += (_, eventArgs) =>
{
    lock (sync) CloseWriter();
    if (eventArgs.Exception != null) Console.Error.WriteLine(eventArgs.Exception.Message);
};

Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    stop = true;
    capture.StopRecording();
};

_ = Task.Run(() =>
{
    while (!stop)
    {
        var line = Console.ReadLine();
        if (line == null || line.Equals("q", StringComparison.OrdinalIgnoreCase))
        {
            stop = true;
            capture.StopRecording();
            break;
        }
    }
});

capture.StartRecording();
Console.WriteLine($"started {capture.WaveFormat}");

while (!stop)
{
    Thread.Sleep(100);
}

lock (sync) CloseWriter();
return 0;
