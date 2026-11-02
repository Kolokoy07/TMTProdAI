// TMTProdAI for Windows. The window is a drop zone, a progress view and a review player; the
// editing itself is done by the user's own Claude Code CLI, run hidden in the TMTProdAI folder
// so it follows the tmtprodai skill exactly as it does in a chat.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const VIDEO_EXT: [&str; 5] = ["mp4", "mov", "m4v", "webm", "mkv"];
// Tools the hidden CLI may use without asking. The app has no one to answer a permission prompt.
const ALLOWED_TOOLS: &str = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,Skill,TodoWrite";

#[derive(Default)]
struct Running(Mutex<Option<u32>>);

#[derive(Default, Serialize, Deserialize)]
struct Config {
    repo: Option<String>,
}

#[derive(Serialize)]
struct Status {
    repo: Option<String>,
    claude: Option<String>,
    kit: bool,
}

#[derive(Serialize)]
struct Draft {
    path: String,
    name: String,
    modified: u64,
}

fn hide(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_file(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn is_repo(p: &Path) -> bool {
    p.join("AGENTS.md").is_file() && p.join("setup.mjs").is_file()
}

// The saved folder, else the TMTProdAI folder this app was built from.
fn repo(app: &AppHandle) -> Option<PathBuf> {
    let built_from = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    load_config(app)
        .repo
        .map(PathBuf::from)
        .into_iter()
        .chain(fs::canonicalize(built_from).ok())
        .find(|p| is_repo(p))
        .map(|p| PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\")))
}

fn allow_outbox(app: &AppHandle, repo: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(repo.join("outbox"), true);
}

// Apps started from Explorer keep the PATH from login, so a CLI installed since then is
// invisible. Read the current PATH from the registry and add the usual install folders.
fn fresh_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;
        let keys = [
            (HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
            (HKEY_CURRENT_USER, "Environment"),
        ];
        for (hive, key) in keys {
            if let Ok(v) = RegKey::predef(hive).open_subkey(key).and_then(|k| k.get_value::<String, _>("Path")) {
                parts.push(expand(&v));
            }
        }
        for (var, sub) in [("APPDATA", "npm"), ("USERPROFILE", r".local\bin")] {
            if let Ok(base) = std::env::var(var) {
                parts.push(format!(r"{base}\{sub}"));
            }
        }
    }
    parts.push(std::env::var("PATH").unwrap_or_default());
    parts.join(";")
}

// Expands %NAME% the way Windows does for REG_EXPAND_SZ values.
fn expand(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => {
                let name = &after[..j];
                out.push_str(&std::env::var(name).unwrap_or_else(|_| format!("%{name}%")));
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn find_claude(path: &str) -> Option<PathBuf> {
    path.split(';')
        .filter(|d| !d.is_empty())
        .flat_map(|d| ["claude.exe", "claude.cmd"].map(|f| Path::new(d).join(f)))
        .find(|f| f.is_file())
}

#[tauri::command]
fn status(app: AppHandle) -> Status {
    let repo = repo(&app);
    if let Some(r) = &repo {
        allow_outbox(&app, r);
    }
    Status {
        kit: repo.as_ref().is_some_and(|r| r.join("kit").is_dir()),
        repo: repo.map(|r| r.to_string_lossy().into_owned()),
        claude: find_claude(&fresh_path()).map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
fn set_repo(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !is_repo(&p) {
        return Err("That folder isn't TMTProdAI. Pick the folder that has AGENTS.md and setup.mjs in it.".into());
    }
    let file = config_file(&app).ok_or("No settings folder")?;
    fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&Config { repo: Some(path) }).unwrap();
    fs::write(file, json).map_err(|e| e.to_string())?;
    allow_outbox(&app, &p);
    Ok(())
}

#[tauri::command]
fn drafts(app: AppHandle) -> Vec<Draft> {
    let Some(outbox) = repo(&app).map(|r| r.join("outbox")) else { return vec![] };
    let mut list: Vec<Draft> = fs::read_dir(outbox)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let is_mp4 = path.extension().is_some_and(|x| x.eq_ignore_ascii_case("mp4"));
            if !is_mp4 || name == "setup-test.mp4" {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
            Some(Draft { path: path.to_string_lossy().into_owned(), name, modified })
        })
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    list
}

// Puts the video in inbox/ (unless it is already there) and returns its path relative to the repo.
#[tauri::command]
async fn add_video(app: AppHandle, path: String) -> Result<String, String> {
    let repo = repo(&app).ok_or("Pick your TMTProdAI folder first.")?;
    let src = PathBuf::from(&path);
    let ext = src.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !VIDEO_EXT.contains(&ext.as_str()) {
        return Err("That isn't a video. Drop an MP4, MOV, M4V, WEBM or MKV file.".into());
    }
    let inbox = repo.join("inbox");
    let name = src.file_name().ok_or("Bad file name")?.to_string_lossy().into_owned();
    if src.parent().and_then(|p| fs::canonicalize(p).ok()) == fs::canonicalize(&inbox).ok() {
        return Ok(format!("inbox/{name}"));
    }
    fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let stem = src.file_stem().unwrap().to_string_lossy().into_owned();
    let mut target = inbox.join(&name);
    let mut n = 2;
    while target.exists() {
        target = inbox.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    fs::copy(&src, &target).map_err(|e| format!("Couldn't copy the video into inbox: {e}"))?;
    Ok(format!("inbox/{}", target.file_name().unwrap().to_string_lossy()))
}

// Runs one Claude Code turn hidden in the repo and streams its JSON lines to the window as
// "claude-line", stderr as "claude-err", and the exit code as "claude-exit".
#[tauri::command]
fn run_claude(app: AppHandle, running: State<Running>, prompt: String, resume: Option<String>) -> Result<(), String> {
    let mut slot = running.0.lock().unwrap();
    if slot.is_some() {
        return Err("An edit is already running.".into());
    }
    let repo = repo(&app).ok_or("Pick your TMTProdAI folder first.")?;
    let path = fresh_path();
    let claude = find_claude(&path).ok_or("Claude Code isn't installed.")?;

    let mut cmd = Command::new(claude);
    cmd.args(["-p", "--output-format", "stream-json", "--verbose"])
        .args(["--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS]);
    if let Some(id) = resume {
        cmd.args(["--resume", &id]);
    }
    // Started from inside a Claude session (dev runs), the app inherits that session's
    // CLAUDE* variables, which make the CLI ignore the user's own sign-in.
    for (key, _) in std::env::vars().filter(|(k, _)| k.starts_with("CLAUDE")) {
        cmd.env_remove(key);
    }
    let mut child = hide(&mut cmd)
        .current_dir(&repo)
        .env("PATH", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start Claude Code: {e}"))?;

    // The prompt goes in on stdin so no quoting rules can mangle it.
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    drop(stdin);

    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let a = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let _ = a.emit("claude-line", line);
        }
    });
    let a = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            let _ = a.emit("claude-err", line);
        }
    });
    *slot = Some(child.id());
    let a = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        *a.state::<Running>().0.lock().unwrap() = None;
        let _ = a.emit("claude-exit", code);
    });
    Ok(())
}

// Stops the running edit and everything it started (renders, ffmpeg).
#[tauri::command]
fn cancel(running: State<Running>) {
    if let Some(pid) = *running.0.lock().unwrap() {
        let _ = hide(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])).status();
    }
}

// Opens a file in its default app, or a folder in Explorer.
#[tauri::command]
fn open_path(path: String, reveal: bool) {
    let mut cmd = Command::new("explorer");
    if reveal {
        cmd.arg(format!("/select,{path}"));
    } else {
        cmd.arg(path);
    }
    let _ = cmd.spawn();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![status, set_repo, drafts, add_video, run_claude, cancel, open_path])
        .run(tauri::generate_context!())
        .expect("error while running TMTProdAI");
}
