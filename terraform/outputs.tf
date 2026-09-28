output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "web_app_name" {
  value = azurerm_linux_web_app.this.name
}

output "web_app_url" {
  value = "https://${azurerm_linux_web_app.this.default_hostname}"
}

output "key_vault_name" {
  value = var.use_key_vault ? azurerm_key_vault.this[0].name : null
}

output "easy_auth_app_client_id" {
  description = "Client (application) ID of the Entra ID app registration backing Easy Auth, if enabled."
  value       = var.enable_easy_auth ? azuread_application.this[0].client_id : null
}

output "easy_auth_assigned_user" {
  description = "UPN that was assigned access, if aad_user_upn was set. Add more under the app's Enterprise Application > Users and groups in the portal."
  value       = var.enable_easy_auth && var.aad_user_upn != "" ? var.aad_user_upn : null
}
