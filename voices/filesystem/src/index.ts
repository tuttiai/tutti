import type { Permission, Voice } from "@tuttiai/types";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { listDirectoryTool } from "./tools/list-directory.js";
import { createDirectoryTool } from "./tools/create-directory.js";
import { deleteFileTool } from "./tools/delete-file.js";
import { moveFileTool } from "./tools/move-file.js";
import { searchFilesTool } from "./tools/search-files.js";

export class FilesystemVoice implements Voice {
  name = "filesystem";
  description = "Read and write files on the local filesystem";
  required_permissions: Permission[] = ["filesystem"];
  tools = [
    readFileTool,
    writeFileTool,
    listDirectoryTool,
    createDirectoryTool,
    deleteFileTool,
    moveFileTool,
    searchFilesTool,
  ];
}

export {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  createDirectoryTool,
  deleteFileTool,
  moveFileTool,
  searchFilesTool,
};
