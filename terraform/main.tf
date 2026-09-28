locals {
  # App Service free/shared tiers don't support Always On.
  always_on = !contains(["F1", "D1", "FREE", "SHARED"], upper(var.sku_name))

  app_settings_plain = merge(
    {
      GITHUB_REPO                    = var.github_repo
      GITHUB_BRANCH                  = var.github_branch
      SCM_DO_BUILD_DURING_DEPLOYMENT = "true"
    },
    var.vault_path != "" ? { VAULT_PATH = var.vault_path } : {},
    var.basic_auth_user != "" ? { BASIC_AUTH_USER = var.basic_auth_user } : {},
    var.commit_author_name != "" ? { COMMIT_AUTHOR_NAME = var.commit_author_name } : {},
    var.commit_author_email != "" ? { COMMIT_AUTHOR_EMAIL = var.commit_author_email } : {},
  )

  github_token_setting = var.use_key_vault ? {
    GITHUB_TOKEN = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.github_token[0].versionless_id})"
    } : {
    GITHUB_TOKEN = var.github_token
  }

  basic_auth_pass_setting = var.basic_auth_pass == "" ? {} : (
    var.use_key_vault ? {
      BASIC_AUTH_PASS = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.basic_auth_pass[0].versionless_id})"
      } : {
      BASIC_AUTH_PASS = var.basic_auth_pass
    }
  )

  easy_auth_secret_setting = !var.enable_easy_auth ? {} : (
    var.use_key_vault ? {
      MICROSOFT_PROVIDER_AUTHENTICATION_SECRET = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.easy_auth_secret[0].versionless_id})"
      } : {
      MICROSOFT_PROVIDER_AUTHENTICATION_SECRET = azuread_application_password.this[0].value
    }
  )

  app_settings = merge(
    local.app_settings_plain,
    local.github_token_setting,
    local.basic_auth_pass_setting,
    local.easy_auth_secret_setting,
  )
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "this" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_service_plan" "this" {
  name                = "${var.app_name}-plan"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  os_type             = "Linux"
  sku_name            = var.sku_name
}

# Zips up exactly what the app needs to run; node_modules is rebuilt on the
# server because SCM_DO_BUILD_DURING_DEPLOYMENT=true triggers Oryx/npm install.
data "archive_file" "app" {
  type        = "zip"
  output_path = "${path.module}/.build/app.zip"

  source {
    content  = file("${path.module}/../server.js")
    filename = "server.js"
  }
  source {
    content  = file("${path.module}/../package.json")
    filename = "package.json"
  }
  source {
    content  = file("${path.module}/../package-lock.json")
    filename = "package-lock.json"
  }
  source {
    content  = file("${path.module}/../public/index.html")
    filename = "public/index.html"
  }
  source {
    content  = file("${path.module}/../public/app.css")
    filename = "public/app.css"
  }
  source {
    content  = file("${path.module}/../public/app.js")
    filename = "public/app.js"
  }
}

resource "azurerm_linux_web_app" "this" {
  name                = var.app_name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_service_plan.this.location
  service_plan_id     = azurerm_service_plan.this.id

  https_only = true

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                         = local.always_on
    health_check_path                 = "/healthz"
    health_check_eviction_time_in_min = 2

    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = local.app_settings

  zip_deploy_file = data.archive_file.app.output_path

  dynamic "auth_settings_v2" {
    for_each = var.enable_easy_auth ? [1] : []

    content {
      auth_enabled           = true
      unauthenticated_action = "RedirectToLoginPage"
      default_provider       = "azureactivedirectory"

      active_directory_v2 {
        client_id                  = azuread_application.this[0].client_id
        client_secret_setting_name = "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"
        tenant_auth_endpoint       = "https://sts.windows.net/${data.azurerm_client_config.current.tenant_id}/v2.0"
      }

      login {
        token_store_enabled = true
      }
    }
  }
}

# ---- Optional: Key Vault-backed secrets (var.use_key_vault = true) ----

resource "azurerm_key_vault" "this" {
  count = var.use_key_vault ? 1 : 0

  name                = substr(replace("${var.app_name}-kv", "/[^a-zA-Z0-9-]/", ""), 0, 24)
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
}

# Lets whoever runs `terraform apply` write the secrets.
resource "azurerm_key_vault_access_policy" "deployer" {
  count = var.use_key_vault ? 1 : 0

  key_vault_id = azurerm_key_vault.this[0].id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = data.azurerm_client_config.current.object_id

  secret_permissions = ["Get", "List", "Set", "Delete", "Purge"]
}

# Lets the web app's managed identity read the secrets at runtime.
resource "azurerm_key_vault_access_policy" "webapp" {
  count = var.use_key_vault ? 1 : 0

  key_vault_id = azurerm_key_vault.this[0].id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_linux_web_app.this.identity[0].principal_id

  secret_permissions = ["Get"]
}

resource "azurerm_key_vault_secret" "github_token" {
  count = var.use_key_vault ? 1 : 0

  name         = "github-token"
  value        = var.github_token
  key_vault_id = azurerm_key_vault.this[0].id

  depends_on = [azurerm_key_vault_access_policy.deployer]
}

resource "azurerm_key_vault_secret" "basic_auth_pass" {
  count = var.use_key_vault && var.basic_auth_pass != "" ? 1 : 0

  name         = "basic-auth-pass"
  value        = var.basic_auth_pass
  key_vault_id = azurerm_key_vault.this[0].id

  depends_on = [azurerm_key_vault_access_policy.deployer]
}

resource "azurerm_key_vault_secret" "easy_auth_secret" {
  count = var.use_key_vault && var.enable_easy_auth ? 1 : 0

  name         = "easy-auth-client-secret"
  value        = azuread_application_password.this[0].value
  key_vault_id = azurerm_key_vault.this[0].id

  depends_on = [azurerm_key_vault_access_policy.deployer]
}
