mod commands;
mod state;
pub mod scheduler;
pub mod energy;
pub mod nb;
pub mod calendar;
pub mod sync;

use state::GlobalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = GlobalState::new();

    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::load,
            commands::snapshot,
            commands::create_task,
            commands::upsert,
            commands::batch_upsert,
            commands::remove,
            commands::set_parent,
            commands::list_sheets,
            commands::upsert_sheet,
            commands::add_sheet,
            commands::remove_sheet,
            commands::search,
            commands::list_tags,
            commands::reorder,
            commands::compute_schedule,
            commands::get_calendar_freebusy,
            commands::get_calendar_debug,
            commands::accept_task_schedule,
            commands::insert_task_at,
            commands::get_setting,
            commands::set_setting,
            commands::get_chunk_config,
            commands::set_chunk_config,
            commands::sync_tasks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
