# ---- Optional: App Service Authentication (Easy Auth) with Entra ID ----
# Automates README step 4's "Recommended" path: creates an app registration,
# turns on 'Assignment required' on its enterprise app (so only assigned users
# can sign in), and — if aad_user_upn is set — assigns that one user.
#
# Requires: permission to register applications in your tenant (on by default
# for all users unless a tenant policy restricts it) and rights to manage the
# app's service principal (automatic for its owner, which is whoever runs
# `terraform apply`).

data "azuread_client_config" "current" {
  count = var.enable_easy_auth ? 1 : 0
}

resource "azuread_application" "this" {
  count = var.enable_easy_auth ? 1 : 0

  display_name     = "${var.app_name}-auth"
  sign_in_audience = var.aad_sign_in_audience
  owners           = [data.azuread_client_config.current[0].object_id]

  web {
    redirect_uris = ["https://${var.app_name}.azurewebsites.net/.auth/login/aad/callback"]

    implicit_grant {
      id_token_issuance_enabled = true
    }
  }
}

resource "azuread_application_password" "this" {
  count = var.enable_easy_auth ? 1 : 0

  application_id = azuread_application.this[0].id
  display_name   = "terraform-managed"
  # end_date_relative is deprecated in favor of end_date = timeadd(timestamp(), ...),
  # but that recomputes on every apply and would rotate (and briefly invalidate)
  # this secret on every run. Keeping the relative form avoids that; the
  # provider's deprecation warning here is expected and harmless.
  end_date_relative = "8760h" # 1 year — bump this and re-apply to rotate
}

# The "Enterprise application" side of the registration. Setting
# app_role_assignment_required = true is the Terraform equivalent of the
# portal's Enterprise Applications -> Properties -> "Assignment required = Yes".
resource "azuread_service_principal" "this" {
  count = var.enable_easy_auth ? 1 : 0

  client_id                    = azuread_application.this[0].client_id
  app_role_assignment_required = true
  owners                       = [data.azuread_client_config.current[0].object_id]
}

data "azuread_user" "this" {
  count = var.enable_easy_auth && var.aad_user_upn != "" ? 1 : 0

  user_principal_name = var.aad_user_upn
}

# Assigns the one allowed user to the app's default access role.
resource "azuread_app_role_assignment" "this" {
  count = var.enable_easy_auth && var.aad_user_upn != "" ? 1 : 0

  app_role_id         = "00000000-0000-0000-0000-000000000000" # built-in "no app roles defined" / default access
  principal_object_id = data.azuread_user.this[0].object_id
  resource_object_id  = azuread_service_principal.this[0].object_id
}
