import re

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _


class CharacterComplexityValidator:
    """
    Require a password to include upper/lowercase letters, a number, and a symbol.
    """

    def validate(self, password, user=None):
        missing_requirements = []

        if not re.search(r"[a-z]", password):
            missing_requirements.append(_("one lowercase letter"))
        if not re.search(r"[A-Z]", password):
            missing_requirements.append(_("one uppercase letter"))
        if not re.search(r"\d", password):
            missing_requirements.append(_("one number"))
        if not re.search(r"[^A-Za-z0-9]", password):
            missing_requirements.append(_("one special character"))

        if missing_requirements:
            raise ValidationError(
                _("Password must include at least %(requirements)s."),
                code="password_missing_character_types",
                params={"requirements": ", ".join(missing_requirements)},
            )

    def get_help_text(self):
        return _(
            "Your password must include uppercase and lowercase letters, a number, "
            "and a special character."
        )
