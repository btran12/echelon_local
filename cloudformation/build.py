"""Regenerate the self-contained CloudFormation template.

The Lambda handler lives in aws/lambda/index.py so it can be edited and tested
like normal Python. This script embeds it into the CloudFormation template so
`aws cloudformation deploy` can be used without an S3 packaging step.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "aws" / "lambda" / "index.py"
TEMPLATE = ROOT / "cloudformation" / "echelon-aws.tpl.yaml"
OUTPUT = ROOT / "cloudformation" / "echelon-aws.yaml"
MARKER = "          # __LAMBDA_CODE__"


def main() -> None:
    code = SOURCE.read_text(encoding="utf-8").rstrip("\n")
    indented = "\n".join(
        ("          " + line) if line.strip() else ""
        for line in code.splitlines()
    )
    template = TEMPLATE.read_text(encoding="utf-8")
    if MARKER not in template:
        raise SystemExit(f"marker not found in {TEMPLATE}")
    OUTPUT.write_text(template.replace(MARKER, indented), encoding="utf-8")
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
