/**
 * Project Discovery Tools - Find Xcode projects and workspaces
 *
 * This module provides tools for scanning directories to discover Xcode project (.xcodeproj)
 * and workspace (.xcworkspace) files. This is useful for initial project exploration and
 * for identifying available projects to work with.
 *
 * Responsibilities:
 * - Recursively scanning directories for Xcode projects and workspaces
 * - Filtering out common directories that should be skipped (build, DerivedData, etc.)
 * - Respecting maximum depth limits to prevent excessive scanning
 * - Providing formatted output with relative paths for discovered files
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from '../utils/logger.js';
import { ToolResponse } from '../types/common.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createTextContent } from './common.js';

// Constants
const DEFAULT_MAX_DEPTH = 5;
const SKIPPED_DIRS = new Set(['build', 'DerivedData', 'Pods', '.git', 'node_modules']);

// Type definition for parameters
type DiscoverProjectsParams = {
  scanPath?: string;
  maxDepth: number;
  workspaceRoot: string;
};

// --- Private Helper Function ---

/**
 * Recursively scans directories to find Xcode projects and workspaces.
 */
async function _findProjectsRecursive(
  currentDirAbs: string,
  workspaceRootAbs: string,
  currentDepth: number,
  maxDepth: number,
  results: { projects: string[]; workspaces: string[] },
): Promise<void> {
  // Explicit depth check (now simplified as maxDepth is always non-negative)
  if (currentDepth >= maxDepth) {
    log('debug', `Max depth ${maxDepth} reached at ${currentDirAbs}, stopping recursion.`);
    return;
  }

  log('debug', `Scanning directory: ${currentDirAbs} at depth ${currentDepth}`);
  const normalizedWorkspaceRoot = path.normalize(workspaceRootAbs);

  try {
    const entries = await fs.readdir(currentDirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const absoluteEntryPath = path.join(currentDirAbs, entry.name);
      const relativePath = path.relative(workspaceRootAbs, absoluteEntryPath);

      // --- Skip conditions ---
      if (entry.isSymbolicLink()) {
        log('debug', `Skipping symbolic link: ${relativePath}`);
        continue;
      }

      // Skip common build/dependency directories by name
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
        log('debug', `Skipping standard directory: ${relativePath}`);
        continue;
      }

      // Ensure entry is within the workspace root (security/sanity check)
      if (!path.normalize(absoluteEntryPath).startsWith(normalizedWorkspaceRoot)) {
        log(
          'warn',
          `Skipping entry outside workspace root: ${absoluteEntryPath} (Workspace: ${workspaceRootAbs})`,
        );
        continue;
      }

      // --- Process entries ---
      if (entry.isDirectory()) {
        let isXcodeBundle = false;

        if (entry.name.endsWith('.xcodeproj')) {
          results.projects.push(relativePath);
          log('debug', `Found project: ${relativePath}`);
          isXcodeBundle = true;
        } else if (entry.name.endsWith('.xcworkspace')) {
          results.workspaces.push(relativePath);
          log('debug', `Found workspace: ${relativePath}`);
          isXcodeBundle = true;
        }

        // Recurse into regular directories, but not into found project/workspace bundles
        if (!isXcodeBundle) {
          await _findProjectsRecursive(
            absoluteEntryPath,
            workspaceRootAbs,
            currentDepth + 1,
            maxDepth,
            results,
          );
        }
      }
    }
  } catch (error: unknown) {
    let code: string | undefined;
    let message = 'Unknown error';

    if (error instanceof Error) {
      message = error.message;
      if ('code' in error) {
        code = (error as NodeJS.ErrnoException).code;
      }
    } else if (typeof error === 'object' && error !== null) {
      if ('message' in error && typeof error.message === 'string') {
        message = error.message;
      }
      if ('code' in error && typeof error.code === 'string') {
        code = error.code;
      }
    } else {
      message = String(error);
    }

    if (code === 'EPERM' || code === 'EACCES') {
      log('debug', `Permission denied scanning directory: ${currentDirAbs}`);
    } else {
      log('warn', `Error scanning directory ${currentDirAbs}: ${message} (Code: ${code ?? 'N/A'})`);
    }
  }
}

/**
 * Internal logic for discovering projects.
 */
async function _handleDiscoveryLogic(params: DiscoverProjectsParams): Promise<ToolResponse> {
  const { scanPath: relativeScanPath, maxDepth, workspaceRoot } = params;

  // Calculate and validate the absolute scan path
  const requestedScanPath = path.resolve(workspaceRoot, relativeScanPath || '.');
  let absoluteScanPath = requestedScanPath;
  const normalizedWorkspaceRoot = path.normalize(workspaceRoot);
  if (!path.normalize(absoluteScanPath).startsWith(normalizedWorkspaceRoot)) {
    log(
      'warn',
      `Requested scan path '${relativeScanPath}' resolved outside workspace root '${workspaceRoot}'. Defaulting scan to workspace root.`,
    );
    absoluteScanPath = normalizedWorkspaceRoot;
  }

  const results = { projects: [] as string[], workspaces: [] as string[] };

  log(
    'info',
    `Starting project discovery request: path=${absoluteScanPath}, maxDepth=${maxDepth}, workspace=${workspaceRoot}`,
  );

  try {
    // Ensure the scan path exists and is a directory
    const stats = await fs.stat(absoluteScanPath);
    if (!stats.isDirectory()) {
      const errorMsg = `Scan path is not a directory: ${absoluteScanPath}`;
      log('error', errorMsg);
      // Return ToolResponse error format
      return {
        content: [createTextContent(errorMsg)],
        isError: true,
      };
    }
  } catch (error: unknown) {
    let code: string | undefined;
    let message = 'Unknown error accessing scan path';

    // Type guards - refined
    if (error instanceof Error) {
      message = error.message;
      // Check for code property specific to Node.js fs errors
      if ('code' in error) {
        code = (error as NodeJS.ErrnoException).code;
      }
    } else if (typeof error === 'object' && error !== null) {
      if ('message' in error && typeof error.message === 'string') {
        message = error.message;
      }
      if ('code' in error && typeof error.code === 'string') {
        code = error.code;
      }
    } else {
      message = String(error);
    }

    const errorMsg = `Failed to access scan path: ${absoluteScanPath}. Error: ${message}`;
    log('error', `${errorMsg} - Code: ${code ?? 'N/A'}`);
    return {
      content: [createTextContent(errorMsg)],
      isError: true,
    };
  }

  // Start the recursive scan from the validated absolute path
  await _findProjectsRecursive(absoluteScanPath, workspaceRoot, 0, maxDepth, results);

  log(
    'info',
    `Discovery finished. Found ${results.projects.length} projects and ${results.workspaces.length} workspaces.`,
  );

  const responseContent = [
    createTextContent(
      `Discovery finished. Found ${results.projects.length} projects and ${results.workspaces.length} workspaces.`,
    ),
  ];

  // Sort results for consistent output
  results.projects.sort();
  results.workspaces.sort();

  if (results.projects.length > 0) {
    responseContent.push(
      createTextContent(
        `Projects (relative to workspace root):\n - ${results.projects.join('\n - ')}`,
      ),
    );
  }

  if (results.workspaces.length > 0) {
    responseContent.push(
      createTextContent(
        `Workspaces (relative to workspace root):\n - ${results.workspaces.join('\n - ')}`,
      ),
    );
  }

  return {
    content: responseContent,
    projects: results.projects,
    workspaces: results.workspaces,
    isError: false,
  };
}

// --- Public Tool Definition ---

export function registerDiscoverProjectsTool(server: McpServer): void {
  server.tool(
    'discover_projects',
    'Scans a directory (defaults to workspace root) to find Xcode project (.xcodeproj) and workspace (.xcworkspace) files.',
    {
      workspaceRoot: z.string().describe('The absolute path of the workspace root to scan within.'),
      scanPath: z
        .string()
        .optional()
        .describe('Optional: Path relative to workspace root to scan. Defaults to workspace root.'),
      maxDepth: z.number().int().nonnegative().optional().default(DEFAULT_MAX_DEPTH).describe(
        `Optional: Maximum directory depth to scan. Defaults to ${DEFAULT_MAX_DEPTH}.`, // Removed mention of -1
      ),
    },
    async (params) => {
      try {
        return await _handleDiscoveryLogic(params as DiscoverProjectsParams);
      } catch (error: unknown) {
        let errorMessage = '';
        if (error instanceof Error) {
          errorMessage = `An unexpected error occurred during project discovery: ${error.message}`;
          log('error', `${errorMessage}\n${error.stack ?? ''}`);
        } else {
          const errorString = String(error);
          log('error', `Caught non-Error value during project discovery: ${errorString}`);
          errorMessage = `An unexpected non-error value was thrown: ${errorString}`;
        }
        return {
          content: [createTextContent(errorMessage)],
          isError: true,
        };
      }
    },
  );
}
