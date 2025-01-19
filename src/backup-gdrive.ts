import { drive } from "@googleapis/drive";
import { JWT } from "google-auth-library";
import { env } from "./env";
import { exec, execSync } from "child_process";
import { unlink } from "fs/promises";
import { statSync } from "fs";
import * as path from "path";
import * as os from "os";
import { filesize } from "filesize";
import { createReadStream } from "fs";
import dayjs from "dayjs";

const auth = new JWT({
  email: env.SERVICE_ACCOUNT.client_email,
  key: env.SERVICE_ACCOUNT.private_key,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const gdrive = drive({
  version: "v3",
  auth: auth,
});

/**
 * Delete old backups in Shared Drive
 */
const deleteStaleBackups = async (cutOffDate: Date) => {
  try {
    // Check access to folder
    const folderAccess = await gdrive.files.get({
      fileId: env.FOLDER_ID,
      fields: "id",
      supportsAllDrives: true,  // ✅ Supports Shared Drives
    });

    if (!folderAccess.data.id) {
      console.error(`No access to FOLDER_ID: ${env.FOLDER_ID}`);
      return;
    }

    // List old backup files in the folder
    const res = await gdrive.files.list({
      pageSize: 100,
      fields: "nextPageToken, files(id, createdTime)",
      q: `'${env.FOLDER_ID}' in parents and trashed=false and mimeType = 'application/gzip' and createdTime < '${cutOffDate.toISOString()}'`,
      includeItemsFromAllDrives: true,  // ✅ Supports Shared Drives
      supportsAllDrives: true,  // ✅ Supports Shared Drives
    });

    if (!res.data.files) {
      return;
    }

    for (const file of res.data.files) {
      if (!file.id) continue;
      await gdrive.files.delete({
        fileId: file.id,
        supportsAllDrives: true,  // ✅ Supports Shared Drives
      });
    }

    console.log("Old backups deleted successfully.");
  } catch (error) {
    console.error("Error deleting stale backups:", error);
  }
};

/**
 * Dump PostgreSQL database to a file
 */
const dumpToFile = async (filePath: string) => {
  return new Promise((resolve, reject) => {
    exec(
      `pg_dump --dbname=${env.DATABASE_URL} --format=tar | gzip > ${filePath}`,
      (err, stdout, stderr) => {
        if (err) {
          reject({
            error: err,
            stderr: stderr.trimEnd(),
          });
          return;
        }

        if (!!stderr) {
          console.log(stderr.trimEnd());
        }

        const isFileValid = execSync(`gzip -cd ${filePath} | head -c1`).length > 0;

        if (!isFileValid) {
          console.error("Backup file is empty");
          reject("Backup file is empty");
          return;
        }

        console.log(`Backup file size: ${filesize(statSync(filePath).size)}`);
        console.log(`Backup file created at: ${filePath}`);

        resolve(stdout);
      },
    );
  });
};

/**
 * Upload backup to Google Drive (Shared Drive supported)
 */
const pushToDrive = async (filename: string, filePath: string) => {
  try {
    // Check access to the folder
    const folderAccess = await gdrive.files.get({
      fileId: env.FOLDER_ID,
      fields: "id",
      supportsAllDrives: true,  // ✅ Supports Shared Drives
    });

    if (!folderAccess.data.id) {
      console.error(`No access to FOLDER_ID: ${env.FOLDER_ID}`);
      return;
    }

    // File metadata
    const fileMetadata = {
      name: filename,
      parents: [env.FOLDER_ID],
    };

    // File upload settings
    const media = {
      mimeType: "application/gzip",
      body: createReadStream(filePath),
    };

    // Upload file
    await gdrive.files.create({
      requestBody: fileMetadata,
      media: media,
      supportsAllDrives: true,  // ✅ Supports Shared Drives
    });

    console.log(`Backup ${filename} uploaded successfully.`);
  } catch (error) {
    console.error("Error uploading to Google Drive:", error);
  }
};

/**
 * Main function: Runs the full backup process
 */
export async function run() {
  try {
    if (env.RETENTION && env.RETENTION !== "disabled") {
      console.log(`Deleting old backups older than a ${env.RETENTION}`);
      const cutOffDate = dayjs().subtract(1, env.RETENTION).toDate();
      await deleteStaleBackups(cutOffDate);
      console.log("Delete complete! Proceeding with backup.");
    }

    // Generate backup file name
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(".", "-");

    const filename = `${env.FILE_PREFIX}${timestamp}.tar.gz`;
    const filePath = path.join(os.tmpdir(), filename);

    console.log(`Starting backup: ${filename}`);

    await dumpToFile(filePath);

    console.log("Backup done! Uploading to Google Drive...");

    await pushToDrive(filename, filePath);

    console.log("Backup uploaded to Google Drive!");

    await unlink(filePath);

    console.log("All done!");
  } catch (err) {
    console.error("Something went wrong:", err);
  }
}
