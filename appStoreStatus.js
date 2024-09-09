import puppeteer from 'puppeteer';
import moment from 'moment-timezone';
import fs from 'fs/promises';
import { Octokit } from "@octokit/rest";
import dotenv from 'dotenv';

dotenv.config();

const main = async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const statuses = [];
    const getCurrentTimestamp = () => moment().tz("America/Los_Angeles").format("YYYY-MM-DD HH:mm:ss z");

    try {
        // App Store Connect and TestFlight status check
        await page.goto('https://developer.apple.com/system-status/', { waitUntil: 'networkidle2' });
        await page.click('.light-toggle-icon#lights-toggle-available');
        await page.waitForSelector('.resolved', { timeout: 60000 });

        const appStoreStatuses = await page.evaluate(() => {
            const extractStatus = (serviceName) => {
                const element = [...document.querySelectorAll('.event')].find(e => e.innerText.includes(serviceName));
                if (element) {
                    const service = element.querySelector('a').innerText.trim().split('\n')[0].trim();
                    const availability = element.querySelector('.resolved').innerText.trim();
                    return { "Service Name": service, "Status": availability };
                }
                return null;
            };

            return ['App Store Connect', 'App Store Connect - TestFlight']
                .map(extractStatus)
                .filter(Boolean);
        });

        appStoreStatuses.forEach(status => {
            status.Timestamp = getCurrentTimestamp();
            statuses.push(status);
        });

        // TestRail Cloud status check
        await page.goto('https://status.testrail.com/', { waitUntil: 'networkidle2' });
        const testRailStatus = await page.evaluate(() => {
            const element = document.querySelector('.component-container');
            if (element) {
                let status = element.querySelector('.component-status').innerText.trim();
                // Replace "Operational" with "Available"
                status = status === "Operational" ? "Available" : status;
                return {
                    "Service Name": element.querySelector('.name').innerText.trim(),
                    "Status": status
                };
            }
            return null;
        });

        if (testRailStatus) {
            testRailStatus.Timestamp = getCurrentTimestamp();
            statuses.push(testRailStatus);
        }

        // AppCenter status check
        await page.goto('https://status.appcenter.ms/', { waitUntil: 'networkidle2' });
        const appCenterStatuses = await page.evaluate(() => {
            const extractStatus = (componentId) => {
                const element = document.querySelector(`[data-component-id="${componentId}"]`);
                if (element) {
                    let status = element.querySelector('.component-status').innerText.trim();
                    // Replace "Operational" with "Available"
                    status = status === "Operational" ? "Available" : status;
                    return {
                        "Service Name": `AppCenter ${element.querySelector('.name').innerText.trim()}`,
                        "Status": status
                    };
                }
                return null;
            };

            return ['4dkck4m5dd0g', 'wdsg44zmnpyk']
                .map(extractStatus)
                .filter(Boolean);
        });

        appCenterStatuses.forEach(status => {
            status.Timestamp = getCurrentTimestamp();
            statuses.push(status);
        });

        // Google Play Store Publishing API status check
        await page.goto('https://status.play.google.com/', { waitUntil: 'networkidle2' });
        const playStoreStatus = await page.evaluate(() => {
            const row = Array.from(document.querySelectorAll('.product-row'))
                .find(row => row.querySelector('.product-name').textContent.trim() === 'Publishing API');
            if (row) {
                const statusIcon = row.querySelector('.psd__status-icon svg');
                let status = 'Unknown';
                if (statusIcon) {
                    if (statusIcon.classList.contains('psd__available')) status = 'Available';
                    else if (statusIcon.classList.contains('psd__disruption')) status = 'Service Disruption';
                    else if (statusIcon.classList.contains('psd__outage')) status = 'Service Outage';
                }
                return { "Service Name": "Google Play Store Publishing API", "Status": status };
            }
            return null;
        });

        if (playStoreStatus) {
            playStoreStatus.Timestamp = getCurrentTimestamp();
            statuses.push(playStoreStatus);
        }

        // After all statuses have been collected:
        const outputData = {
            timestamp: getCurrentTimestamp(),
            statuses: statuses
        };

        // Call the function with your output
        await saveAndCommit(outputData);

    } catch (error) {
        console.error('Error occurred:', error);
    } finally {
        await browser.close();
    }
};

async function saveAndCommit(output) {
    // Adjust service names to match the image
    output.statuses = output.statuses.map(status => {
        switch(status["Service Name"]) {
            case "App Store Connect":
                return status;
            case "App Store Connect - TestFlight":
                return { ...status, "Service Name": "TestFlight" };
            case "TestRail Cloud":
                return status;
            case "AppCenter Distribute":
                return status;
            case "AppCenter Portal":
                return status;
            case "Google Play Store Publishing API":
                return { ...status, "Service Name": "Google Play Store" };
            default:
                return status;
        }
    });

    // Save output locally
    const filename = 'output.json';
    await fs.writeFile(filename, JSON.stringify(output, null, 2));
    console.log(`Status information has been saved to ${filename}`);

    // GitHub integration
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const [owner, repo] = process.env.GITHUB_REPO.split('/');

    try {
        // Get current content of output.json from the repo
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: filename,
        });

        // Commit changes
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: filename,
            message: 'Update output.json',
            content: Buffer.from(JSON.stringify(output, null, 2)).toString('base64'),
            sha: fileData.sha,
        });

        console.log("Changes committed to GitHub repository.");
    } catch (error) {
        if (error.status === 404) {
            // File doesn't exist, create it
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: filename,
                message: 'Create output.json',
                content: Buffer.from(JSON.stringify(output, null, 2)).toString('base64'),
            });
            console.log("File created and committed to GitHub repository.");
        } else {
            console.error("Error interacting with GitHub:", error);
        }
    }
}

main().catch(console.error);
