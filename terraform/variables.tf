variable "resource_group_name" {
  description = "Name of the Azure resource group to create."
  type        = string
  default     = "rg-vault-web"
}

variable "location" {
  description = "Azure region to deploy into."
  type        = string
  default     = "centralus"
}

variable "app_name" {
  description = "Globally unique App Service name. The app will be reachable at https://<app_name>.azurewebsites.net"
  type        = string
  default     = "vault-web-michael"
}

variable "sku_name" {
  description = "App Service Plan SKU. F1 is free (cold starts, daily CPU quota); B1 avoids cold starts and costs a few dollars/month."
  type        = string
  default     = "F1"
}

variable "github_token" {
  description = "Fine-grained GitHub PAT with 'Contents: Read and write' on the vault repo. Pass via TF_VAR_github_token or a gitignored *.auto.tfvars file — never commit it."
  type        = string
  sensitive   = true
}

variable "github_repo" {
  description = "owner/repo of the Obsidian vault, e.g. Michaelbecze/Obsidian."
  type        = string
  default     = "Michaelbecze/Obsidian"
}

variable "github_branch" {
  description = "Branch the app reads from and commits to."
  type        = string
  default     = "main"
}

variable "vault_path" {
  description = "Subfolder within the repo if the vault isn't at the repo root. Leave empty for repo root."
  type        = string
  default     = ""
}

variable "basic_auth_user" {
  description = "Optional HTTP basic auth username (quick alternative to App Service Easy Auth)."
  type        = string
  default     = ""
}

variable "basic_auth_pass" {
  description = "Optional HTTP basic auth password. Required if basic_auth_user is set."
  type        = string
  default     = ""
  sensitive   = true
}

variable "commit_author_name" {
  description = "Committer name shown on commits made from the web UI."
  type        = string
  default     = ""
}

variable "commit_author_email" {
  description = "Committer email shown on commits made from the web UI."
  type        = string
  default     = ""
}

variable "use_key_vault" {
  description = "If true, store GITHUB_TOKEN (and basic_auth_pass / the Easy Auth client secret, if set) in a new Azure Key Vault and wire the app to read them via its system-assigned managed identity, instead of storing them as plain-text app settings."
  type        = bool
  default     = false
}

variable "enable_easy_auth" {
  description = "If true, provisions an Entra ID app registration and turns on App Service Authentication (Easy Auth), requiring sign-in before anyone can reach the site. This is the Terraform equivalent of README step 4's recommended path."
  type        = bool
  default     = false
}

variable "aad_user_upn" {
  description = "UPN (usually the email) of the single Entra ID user allowed to sign in, e.g. you@yourtenant.onmicrosoft.com or your work account's email. Only used when enable_easy_auth = true. Leave empty to skip automatic assignment and add users yourself later under the app's Enterprise Application > Users and groups — required if you're signing in with a personal Microsoft account (MSA) that isn't already a member or guest in this tenant, since assigning an app role needs an existing user object to point at."
  type        = string
  default     = ""
}

variable "aad_sign_in_audience" {
  description = "Entra ID sign_in_audience for the app registration. \"AzureADMyOrg\" (default) restricts sign-in to this tenant's accounts. Use \"AzureADandPersonalMicrosoftAccount\" if you sign in with a personal Microsoft account (outlook.com, etc.) — see aad_user_upn's note about that case."
  type        = string
  default     = "AzureADMyOrg"
}
