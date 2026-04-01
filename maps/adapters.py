from allauth.socialaccount.adapter import DefaultSocialAccountAdapter

from .models import CustomUser


class GoogleSocialAccountAdapter(DefaultSocialAccountAdapter):
    """
    Reuse an existing local user when Google returns the same email.
    """

    def pre_social_login(self, request, sociallogin):
        """
        This hook runs after Google authenticates the user, but before
        allauth finishes the login/signup flow.

        If the social account already exists, do nothing.
        If the email matches an existing local user, connect the Google
        account to that user instead of creating a duplicate.
        """
        if sociallogin.is_existing:
            return

        email = (
            (
                sociallogin.account.extra_data.get("email")
                or sociallogin.user.email
                or ""
            )
            .strip()
            .lower()
        )

        if not email:
            return

        try:
            existing_user = CustomUser.objects.get(email__iexact=email)
        except CustomUser.DoesNotExist:
            return

        sociallogin.connect(request, existing_user)
