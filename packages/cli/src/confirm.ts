import inquirer from 'inquirer';

/**
 * CLI confirm callback for ask-confirm shell permission level.
 * Shows the command to the user and waits for approval.
 */
export async function cliConfirmCallback(command: string): Promise<boolean> {
  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Agent wants to execute shell command:\n\n  ${command}\n\nAllow?`,
      default: false,
    },
  ]);
  return confirmed as boolean;
}
